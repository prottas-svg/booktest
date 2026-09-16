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

function isbn13To10(isbn13){
  const n=normalizeISBN(isbn13);
  if(!/^978\d{10}$/.test(n)) return null;
  const core=n.slice(3,12);
  let sum=0;
  for(let i=0;i<9;i++) sum+=Number(core[i])*(10-i);
  const check=(11-(sum%11))%11;
  return core+(check===10?"X":String(check));
}
function equivalentISBNs(isbn){
  const n=normalizeISBN(isbn);
  const out=new Set([n]);
  const isbn10=isbn13To10(n);
  if(isbn10) out.add(isbn10);
  return [...out];
}
function textContainsISBN(text,isbn){
  const raw=String(text||"").toUpperCase();
  // Compare normalized digit/X runs rather than compacting the entire page,
  // which can accidentally join unrelated numbers together.
  const tokens=(raw.match(/[0-9X][0-9X\-\s]{8,20}[0-9X]/g)||[])
    .map(normalizeISBN)
    .filter(v=>v.length===10||v.length===13);
  return equivalentISBNs(isbn).some(candidate=>tokens.includes(candidate));
}

function normalizeTitleForMatch(s=""){
  return String(s)
    .toLowerCase()
    .replace(/\([^)]*\)/g," ")
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\b(a|an|the)\b/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function normalizeAuthorForMatch(s=""){
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function titleAuthorMatch(searchTitle,searchAuthor,resultText){
  const rt=normalizeTitleForMatch(resultText);
  const ra=normalizeAuthorForMatch(resultText);
  const t=normalizeTitleForMatch(searchTitle);
  const a=normalizeAuthorForMatch(searchAuthor);
  if(!t || !a) return false;
  const titleOk = rt.includes(t) || t.includes(rt);
  const authorTokens=a.split(" ").filter(Boolean);
  const authorOk = authorTokens.length
    ? authorTokens.every(tok=>ra.includes(tok))
    : false;
  return titleOk && authorOk;
}

async function fetchJson(url,timeoutMs=8000){
  const c=new AbortController();
  const t=setTimeout(()=>c.abort(),timeoutMs);
  try{
    const r=await fetch(url,{signal:c.signal,headers:{"user-agent":"MyARShelf/3.2"}});
    if(!r.ok) return null;
    return await r.json();
  }catch{
    return null;
  }finally{
    clearTimeout(t);
  }
}

async function lookupSiblingISBNs(isbn){
  const edition=await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
  const workKey=edition?.works?.[0]?.key;
  if(!workKey) return [];

  const editions=await fetchJson(`https://openlibrary.org${workKey}/editions.json?limit=50`);
  const out=[];
  for(const e of editions?.entries||[]){
    for(const candidate of [...(e.isbn_13||[]),...(e.isbn_10||[])]){
      const n=normalizeISBN(candidate);
      if((n.length===10||n.length===13) && n!==normalizeISBN(isbn) && !out.includes(n)){
        out.push(n);
      }
    }
  }
  return out.slice(0,24);
}

async function searchBookfinderExactISBN(page,isbn){
  await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
  const input=await findISBNInput(page);
  if(!input) return null;
  await input.fill(isbn);
  await submitSearch(page,input);
  await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
  await page.waitForTimeout(500);

  let searchText=await page.locator("body").innerText();
  const lower=searchText.toLowerCase();
  if(/no results|no books|0 results|did not match|no matches/.test(lower)) return null;

  const verifiedOnSearch=textContainsISBN(searchText,isbn);
  const exactLink=await findExactResultLink(page,isbn);
  const detailLinks=page.locator('a[href*="bookdetail.aspx" i]');
  const count=await detailLinks.count();
  let text=searchText;

  if(exactLink){
    await exactLink.click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(500);
    text=await page.locator("body").innerText();
  }else if(count===1 && verifiedOnSearch){
    await detailLinks.first().click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(500);
    text=await page.locator("body").innerText();
  }

  if(!/AR Quiz No\./i.test(text) && verifiedOnSearch && /AR Quiz No\./i.test(searchText)){
    text=searchText;
  }
  if(!/AR Quiz No\./i.test(text)) return null;
  if(!(verifiedOnSearch || textContainsISBN(text,isbn))) return null;

  const ar=parseAR(text,isbn,page.url());
  ar.matchBasis="related_edition_isbn";
  ar.matchedISBN=isbn;
  return ar;
}

async function searchBookfinderByTitleAuthor(page,title,author){
  const findVisible = async (selectors, labelRegex) => {
    for(const sel of selectors){
      const loc=page.locator(sel).first();
      if(await loc.count() && await loc.isVisible().catch(()=>false)) return loc;
    }
    if(labelRegex){
      const byLabel=page.getByLabel(labelRegex).first();
      if(await byLabel.count() && await byLabel.isVisible().catch(()=>false)) return byLabel;
    }
    return null;
  };

  const titleInput=await findVisible(
    ['input[name*="Title" i]','input[id*="Title" i]','input[placeholder*="title" i]'],
    /title/i
  );
  if(!titleInput) throw new Error("Could not locate the Title field on AR Bookfinder.");

  await titleInput.fill(title);

  const form = titleInput.locator('xpath=ancestor::form[1]');
  let submitted=false;

  if(await form.count()){
    const submitSelectors=[
      'input[type="submit"][value*="Search" i]',
      'input[type="submit"][value*="Go" i]',
      'button[type="submit"]:has-text("Search")',
      'button[type="submit"]:has-text("Go")',
      'input[type="image"]'
    ];
    for(const sel of submitSelectors){
      const btn=form.locator(sel).first();
      if(await btn.count() && await btn.isVisible().catch(()=>false)){
        await btn.click();
        submitted=true;
        break;
      }
    }
  }

  if(!submitted){
    await titleInput.press("Enter").catch(()=>{});
  }

  await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
  await page.waitForTimeout(700);

  const bodyText=await page.locator("body").innerText();
  const lower=bodyText.toLowerCase();
  if(/no results|no books|0 results|did not match|no matches/.test(lower)) return null;

  const links=page.locator('a[href*="bookdetail.aspx" i]');
  const count=await links.count();
  const matches=[];

  for(let i=0;i<count;i++){
    const link=links.nth(i);
    let bestText="";
    for(const xpath of [
      'xpath=ancestor::tr[1]',
      'xpath=ancestor::li[1]',
      'xpath=ancestor::div[1]',
      'xpath=ancestor::div[2]',
      'xpath=ancestor::div[3]'
    ]){
      try{
        const anc=link.locator(xpath);
        if(await anc.count()){
          const t=await anc.innerText().catch(()=>"");
          if(t.length>bestText.length) bestText=t;
          if(titleAuthorMatch(title,author,t)){
            bestText=t;
            break;
          }
        }
      }catch{}
    }
    if(titleAuthorMatch(title,author,bestText)) matches.push({link,rowText:bestText});
  }

  if(matches.length===1){
    const match=matches[0];

    if(/AR Quiz No\./i.test(match.rowText) && /ATOS Book Level|Book Level|\bBL\b/i.test(match.rowText)){
      return {
        text:match.rowText,
        pageUrl:page.url(),
        matchBasis:"title_author"
      };
    }

    await match.link.click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(500);
    const detailText=await page.locator("body").innerText();

    if(/AR Quiz No\./i.test(detailText)){
      return {
        text:detailText,
        pageUrl:page.url(),
        matchBasis:"title_author"
      };
    }
  }

  if(count<=1 &&
     titleAuthorMatch(title,author,bodyText) &&
     /AR Quiz No\./i.test(bodyText) &&
     /ATOS Book Level|Book Level|\bBL\b/i.test(bodyText)){
    return {
      text:bodyText,
      pageUrl:page.url(),
      matchBasis:"title_author"
    };
  }

  return null;
}
async function findExactResultLink(page,isbn){
  const links=page.locator('a[href*="bookdetail.aspx" i]');
  const count=await links.count();
  for(let i=0;i<count;i++){
    const link=links.nth(i);
    // Search a few increasingly broad ancestors because Bookfinder layouts vary.
    for(const xpath of ['xpath=ancestor::tr[1]','xpath=ancestor::li[1]','xpath=ancestor::div[1]','xpath=ancestor::div[2]']){
      try{
        const anc=link.locator(xpath);
        if(await anc.count()){
          const t=await anc.innerText().catch(()=>"");
          if(textContainsISBN(t,isbn)) return link;
        }
      }catch{}
    }
  }
  return null;
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
    let searchText=await page.locator("body").innerText();
    let text=searchText;

    const lowerSearch=searchText.toLowerCase();
    if(/no results|no books|0 results|did not match|no matches/.test(lowerSearch)){
      const bib=await bibPromise;

      // First try sibling editions of the SAME Open Library work.
      try{
        const siblings=await lookupSiblingISBNs(isbn);
        for(const sibling of siblings){
          const siblingAR=await searchBookfinderExactISBN(page,sibling);
          if(siblingAR){
            return {
              ...siblingAR,
              isbn,
              scannedISBN:isbn,
              title:bib?.title||null,
              author:bib?.author||null,
              cover:bib?.cover||null,
              pages:bib?.pages||null,
              metadataSource:bib?.metadataSource||"Open Library",
              arSource:"AR Bookfinder",
              matchBasis:"related_edition_isbn",
              matchedISBN:sibling,
              lookedUpAt:new Date().toISOString()
            };
          }
        }
      }catch(editionErr){
        console.warn("[related-edition fallback]",editionErr?.message||editionErr);
      }

      // If no sibling ISBN works, fall back to a strict title+author search.
      if(bib?.title && bib?.author){
        try{
          // Return to advanced search before the fallback query.
          await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
          const fallback=await searchBookfinderByTitleAuthor(page,bib.title,bib.author);
          if(fallback){
            const ar=parseAR(fallback.text,isbn,fallback.pageUrl);
            return {
              ...ar,
              title:bib.title,
              author:bib.author,
              cover:bib.cover||null,
              pages:bib.pages||null,
              metadataSource:bib.metadataSource||"Open Library",
              arSource:"AR Bookfinder",
              matchBasis:"title_author",
              lookedUpAt:new Date().toISOString()
            };
          }
        }catch(fallbackErr){
          console.warn("[title-author fallback]",fallbackErr?.message||fallbackErr);
        }
      }

      const e=new Error("No AR result was found by ISBN, and the title search did not produce one unique matching title/author result.");
      e.code="NOT_FOUND";e.bib=bib;throw e;
    }

    // Verify the ISBN on the SEARCH RESULTS page before navigating away.
    // Bookfinder's detail pages often omit ISBN entirely, which caused valid books
    // to be mislabeled ISBN_MISMATCH in v2.4.
    const verifiedOnSearch=textContainsISBN(searchText,isbn);
    const exactLink=await findExactResultLink(page,isbn);
    const detailLinks=page.locator('a[href*="bookdetail.aspx" i]');
    const count=await detailLinks.count();

    if(exactLink){
      await exactLink.click();
      await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
      await page.waitForTimeout(500);
      text=await page.locator("body").innerText();
    }else if(count===1 && verifiedOnSearch){
      await detailLinks.first().click();
      await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
      await page.waitForTimeout(500);
      text=await page.locator("body").innerText();
    }

    if(!/AR Quiz No\./i.test(text)){
      // Some search-result layouts contain the AR fields directly.
      // If navigation removed them, fall back to the verified search text.
      if(verifiedOnSearch && /AR Quiz No\./i.test(searchText)) {
        text=searchText;
      } else {
        const e=new Error("Bookfinder returned a page, but its AR fields could not be recognized.");
        e.code="PARSE_CHANGED";throw e;
      }
    }

    // Accuracy guard: prefer exact ISBN verification. If Bookfinder returns AR data
    // for the work but does not expose the edition ISBN, allow a strict title+author
    // match against bibliographic metadata. This is labelled honestly as title_author.
    const verified=verifiedOnSearch || textContainsISBN(text,isbn);
    const bib=await bibPromise;
    let matchBasis="isbn";

    if(!verified){
      const titleAuthorVerified=
        bib?.title && bib?.author &&
        (titleAuthorMatch(bib.title,bib.author,searchText) ||
         titleAuthorMatch(bib.title,bib.author,text));

      if(titleAuthorVerified){
        matchBasis="title_author";
      }else{
        const e=new Error("Bookfinder returned AR data, but the result could not be tied to this book by ISBN or a clear title/author match.");
        e.code="ISBN_MISMATCH";e.bib=bib;throw e;
      }
    }

    const ar=parseAR(text,isbn,page.url());
    ar.matchBasis=matchBasis;
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

app.get("/health",(_req,res)=>res.status(200).json({ok:true,service:"scan-ar",version:"3.2.0",time:new Date().toISOString()}));
app.get("/api/lookup-status",(_req,res)=>res.json({
  ok:true,
  version:"3.2.0",
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
const server=app.listen(port,"0.0.0.0",()=>console.log(`My AR Shelf v2.6.0 listening on ${port}`));
async function shutdown(){
  console.log("Shutting down…");server.close();
  if(browserPromise){try{(await browserPromise).close()}catch{}}
  process.exit(0);
}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
