import express from "express";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static("public", { maxAge: 0 }));

const BOOKFINDER_URL = "https://www.arbookfind.com/advanced.aspx?client=PBQN";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const BACKUP_DIR = process.env.BACKUP_DIR || "/data/backups";
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

async function ensureBackupDir(){
  await fs.mkdir(BACKUP_DIR,{recursive:true});
}
function normalizeRecoveryCode(value=""){
  const raw=String(value).toUpperCase().replace(/[^A-Z0-9]/g,"");
  if(raw.length!==16)return null;
  return [raw.slice(0,4),raw.slice(4,8),raw.slice(8,12),raw.slice(12,16)].join("-");
}
function backupPath(code){
  const hash=crypto.createHash("sha256").update(code).digest("hex");
  return path.join(BACKUP_DIR,hash+".json");
}

let browserPromise;

function normalizeISBN(value = "") {
  return String(value).replace(/[^0-9Xx]/g, "").toUpperCase();
}
function validISBN10(isbn) {
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  const sum = [...isbn].reduce((s,c,i)=>s+(c==="X"?10:Number(c))*(10-i),0);
  return sum % 11 === 0;
}
function validISBN13(isbn) {
  if (!/^\d{13}$/.test(isbn)) return false;
  const sum = [...isbn.slice(0,12)].reduce((s,c,i)=>s+Number(c)*(i%2?3:1),0);
  return (10-(sum%10))%10 === Number(isbn[12]);
}
function isValidISBN(isbn) {
  return isbn.length===10 ? validISBN10(isbn) : isbn.length===13 ? validISBN13(isbn) : false;
}

async function lookupBibliographic(isbn) {
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=data&format=json`);
    if (!r.ok) return null;
    const j = await r.json();
    const d = j[`ISBN:${isbn}`];
    if (!d) return null;
    return {
      title: d.title || null,
      author: Array.isArray(d.authors) ? d.authors.map(a=>a.name).filter(Boolean).join(", ") : null,
      cover: d.cover?.medium || d.cover?.small || null,
      pages: d.number_of_pages || null,
      metadataSource: "Open Library"
    };
  } catch {
    return null;
  }
}

function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless:true,
      args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage"]
    }).catch(err=>{browserPromise=undefined;throw err});
  }
  return browserPromise;
}

function firstMatch(text, regexes) {
  for (const re of regexes) {
    const m=text.match(re);
    if(m?.[1]) return m[1].trim();
  }
  return null;
}
function parseAR(text,isbn,finalUrl) {
  const normalized=text.replace(/\u00a0/g," ").replace(/[ \t]+/g," ");
  const quizNumber=firstMatch(normalized,[/AR Quiz No\.?:?\s*#?([0-9]+)/i,/Quiz Number:?\s*#?([0-9]+)/i]);
  const atosRaw=firstMatch(normalized,[/ATOS Book Level:?\s*([0-9.]+)/i,/\bBL:?\s*([0-9.]+)/i]);
  const pointsRaw=firstMatch(normalized,[/AR Points:?\s*([0-9.]+)/i,/AR Pts:?\s*([0-9.]+)/i]);
  const interest=firstMatch(normalized,[/Interest Level:?\s*([^\n\r]+)/i,/\bIL:?\s*([A-Z]+\+?)/]);
  const wordRaw=firstMatch(normalized,[/Word Count:?\s*([0-9,]+)/i]);
  if(!quizNumber || atosRaw==null) {
    const e=new Error("Bookfinder returned a result, but required AR fields could not be recognized.");
    e.code="PARSE_CHANGED";throw e;
  }
  return {
    isbn,quizNumber,atos:Number(atosRaw),points:pointsRaw?Number(pointsRaw):null,
    interestLevel:interest,wordCount:wordRaw?Number(wordRaw.replace(/,/g,"")):null,
    arSource:"AR Bookfinder",sourceUrl:finalUrl,lookedUpAt:new Date().toISOString()
  };
}

async function findISBNInput(page) {
  for (const selector of ['input[aria-label*="ISBN" i]','input[placeholder*="ISBN" i]','input[name*="isbn" i]','input[id*="isbn" i]']) {
    const loc=page.locator(selector).first();
    if(await loc.count() && await loc.isVisible().catch(()=>false)) return loc;
  }
  const labelled=page.getByLabel(/ISBN/i).first();
  if(await labelled.count()) return labelled;
  const handle=await page.evaluateHandle(()=>{
    const all=[...document.querySelectorAll("input[type=text],input:not([type])")];
    return all.find(input=>/isbn/i.test((input.id||"")+" "+(input.name||"")+" "+(input.parentElement?.innerText||"")))||null;
  });
  const el=handle.asElement();
  if(!el) throw new Error("Could not locate the ISBN field on AR Bookfinder.");
  return el;
}

async function submitSearch(page,input) {
  try{
    await input.press("Enter");
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(650);
    if(/AR Quiz No\.|No Results|no books|0 results|did not match/i.test(await page.locator("body").innerText())) return;
  }catch{}
  const candidates=[
    page.getByRole("button",{name:/^search$/i}).first(),
    page.locator('input[type="submit"][value*="Search" i]').first(),
    page.locator('button:has-text("Search")').first(),
    page.locator('a:has-text("Search")').first()
  ];
  for(const c of candidates){
    try{
      if(await c.count()&&await c.isVisible()){
        await c.click();await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});await page.waitForTimeout(650);return;
      }
    }catch{}
  }
  throw new Error("Could not submit the AR Bookfinder search form.");
}

function pageContainsExactISBN(text,isbn) {
  const compact=String(text).replace(/[^0-9Xx]/g,"").toUpperCase();
  return compact.includes(isbn);
}

async function performLookup(isbn,{refresh=false}={}) {
  const hit=cache.get(isbn);
  if(!refresh && hit && Date.now()-hit.time<CACHE_TTL_MS) return {...hit.value,cached:true};

  const bibPromise=lookupBibliographic(isbn);
  const browser=await getBrowser();
  const context=await browser.newContext({
    viewport:{width:1280,height:900},
    userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
  });
  context.setDefaultTimeout(12000);
  try{
    const page=await context.newPage();
    await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:25000});
    const input=await findISBNInput(page);
    await input.fill(isbn);
    await submitSearch(page,input);
    let text=await page.locator("body").innerText();

    const detailLinks=page.locator('a[href*="bookdetail.aspx" i]');
    const count=await detailLinks.count();
    if(count===1){
      await detailLinks.first().click();
      await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
      await page.waitForTimeout(500);
      text=await page.locator("body").innerText();
    }

    if(!/AR Quiz No\./i.test(text)){
      const lower=text.toLowerCase();
      if(/no results|no books|0 results|did not match|no matches/.test(lower)){
        const bib=await bibPromise;
        const e=new Error("No Accelerated Reader quiz was found for that ISBN.");
        e.code="NOT_FOUND";e.bib=bib;throw e;
      }
      const e=new Error("Bookfinder returned a page, but its AR fields could not be recognized.");
      e.code="PARSE_CHANGED";throw e;
    }

    // Accuracy guard: never accept AR values unless the exact scanned ISBN is visibly
    // associated with the returned result/detail page.
    if(!pageContainsExactISBN(text,isbn)){
      const e=new Error("Bookfinder returned a result, but the exact scanned ISBN could not be verified on the result page.");
      e.code="ISBN_MISMATCH";throw e;
    }

    const ar=parseAR(text,isbn,page.url());
    const bib=await bibPromise;
    const value={
      ...ar,
      title:bib?.title||null,
      author:bib?.author||null,
      cover:bib?.cover||null,
      pages:bib?.pages||null,
      metadataSource:bib?.metadataSource||"AR Bookfinder"
    };
    cache.set(isbn,{time:Date.now(),value});
    return {...value,cached:false};
  }finally{
    await context.close().catch(()=>{});
  }
}


app.put("/api/backup/:code", async (req,res)=>{
  const code=normalizeRecoveryCode(req.params.code);
  if(!code)return res.status(400).json({error:"Invalid recovery code."});
  const payload=req.body;
  if(!payload?.data || typeof payload.data!=="object")return res.status(400).json({error:"Invalid backup payload."});
  const serialized=JSON.stringify(payload.data);
  if(Buffer.byteLength(serialized,"utf8")>MAX_BACKUP_BYTES)return res.status(413).json({error:"Backup is too large."});
  try{
    await ensureBackupDir();
    const savedAt=new Date().toISOString();
    const record={version:1,savedAt,clientUpdatedAt:payload.clientUpdatedAt||null,data:payload.data};
    const target=backupPath(code),temp=target+".tmp";
    await fs.writeFile(temp,JSON.stringify(record),"utf8");
    await fs.rename(temp,target);
    return res.json({ok:true,savedAt});
  }catch(e){
    console.error("[backup write]",e);
    return res.status(503).json({error:"Online backup storage is unavailable. Make sure a Railway volume is mounted at /data."});
  }
});

app.get("/api/backup/:code", async (req,res)=>{
  const code=normalizeRecoveryCode(req.params.code);
  if(!code)return res.status(400).json({error:"Invalid recovery code."});
  try{
    const raw=await fs.readFile(backupPath(code),"utf8");
    const record=JSON.parse(raw);
    return res.json({ok:true,savedAt:record.savedAt,data:record.data});
  }catch(e){
    if(e?.code==="ENOENT")return res.status(404).json({error:"No backup was found for that recovery code."});
    console.error("[backup read]",e);
    return res.status(503).json({error:"Online backup storage is unavailable."});
  }
});

app.get("/health",(_req,res)=>res.status(200).json({ok:true,service:"scan-ar",version:"2.4.0",time:new Date().toISOString()}));
app.get("/api/lookup-status",(_req,res)=>res.json({
  ok:true,
  version:"2.4.0",
  bookfinderUrl:BOOKFINDER_URL,
  browserInitialized:Boolean(browserPromise),
  cacheEntries:cache.size
}));

app.get("/api/status",async(_req,res)=>{
  try{const b=await getBrowser();res.json({ok:true,browserConnected:b.isConnected(),cacheEntries:cache.size})}
  catch(e){res.status(503).json({ok:false,browserConnected:false,error:String(e?.message||e)})}
});

app.get("/api/ar/:isbn",async(req,res)=>{
  const isbn=normalizeISBN(req.params.isbn);
  if(!isValidISBN(isbn))return res.status(400).json({error:"Enter a valid ISBN-10 or ISBN-13 (checksum failed)."});
  try{
    const result=await performLookup(isbn,{refresh:req.query.refresh==="1"});
    return res.json(result);
  }catch(e){
    console.error(`[lookup ${isbn}]`,e);
    if(e.code==="NOT_FOUND"){
      const bib=e.bib||await lookupBibliographic(isbn);
      return res.status(404).json({
        error:e.message,reason:"no_ar_record",isbn,
        title:bib?.title||null,author:bib?.author||null,cover:bib?.cover||null,pages:bib?.pages||null,
        metadataSource:bib?.metadataSource||null,lookedUpAt:new Date().toISOString()
      });
    }
    const bib=e.bib||await lookupBibliographic(isbn);
    const fallback={
      isbn,
      title:bib?.title||null,
      author:bib?.author||null,
      cover:bib?.cover||null,
      pages:bib?.pages||null,
      metadataSource:bib?.metadataSource||null,
      lookedUpAt:new Date().toISOString()
    };
    if(e.code==="ISBN_MISMATCH")return res.status(502).json({...fallback,error:e.message,code:e.code});
    if(e.code==="PARSE_CHANGED")return res.status(502).json({...fallback,error:e.message,code:e.code});
    return res.status(502).json({...fallback,error:"AR Bookfinder lookup failed.",detail:String(e?.message||e)});
  }
});

const port=Number(process.env.PORT||3000);
const server=app.listen(port,"0.0.0.0",()=>console.log(`Scan AR v2.4.0 listening on ${port}`));
async function shutdown(){
  console.log("Shutting down…");server.close();
  if(browserPromise){try{(await browserPromise).close()}catch{}}
  process.exit(0);
}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
