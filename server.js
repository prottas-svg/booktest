import express from "express";
import { chromium } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const app = express();
app.disable("x-powered-by");
app.use(express.json({limit:"5mb"}));
app.use(express.static("public", { maxAge: 0 }));

const BOOKFINDER_URL = "https://www.arbookfind.com/advanced.aspx?client=PBQN";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

const BACKUP_DIR = process.env.BACKUP_DIR || "/data/backups";
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

const TELEMETRY_DIR = process.env.TELEMETRY_DIR || "/data/telemetry";
const TELEMETRY_FILE = path.join(TELEMETRY_DIR,"events.ndjson");
const TELEMETRY_ARCHIVE_FILE = path.join(TELEMETRY_DIR,"events-previous.ndjson");
const TELEMETRY_ROTATE_BYTES = 25 * 1024 * 1024;
const MAX_TELEMETRY_BODY_BYTES = 12 * 1024;

async function ensureTelemetryDir(){
  await fs.mkdir(TELEMETRY_DIR,{recursive:true});
}

function safeTelemetryString(value,max=300){
  return String(value??"").slice(0,max);
}

function sanitizeTelemetryProperties(input){
  if(!input || typeof input!=="object" || Array.isArray(input)) return {};
  const out={};
  const forbidden=/recovery|child[_-]?name|kid[_-]?name|backup[_-]?data|library[_-]?data|full[_-]?title/i;
  let count=0;
  for(const [rawKey,rawVal] of Object.entries(input)){
    if(count>=24) break;
    const key=safeTelemetryString(rawKey,60).replace(/[^a-zA-Z0-9_.-]/g,"_");
    if(!key || forbidden.test(key)) continue;
    if(rawVal==null || typeof rawVal==="boolean" || typeof rawVal==="number"){
      out[key]=rawVal;
    }else if(typeof rawVal==="string"){
      out[key]=safeTelemetryString(rawVal,300);
    }else if(Array.isArray(rawVal)){
      out[key]=rawVal.slice(0,20).map(v=>{
        if(v==null || typeof v==="boolean" || typeof v==="number") return v;
        return safeTelemetryString(v,120);
      });
    }
    count++;
  }
  return out;
}

function normalizeTelemetryEvent(body){
  if(!body || typeof body!=="object") return null;
  const eventName=safeTelemetryString(body.eventName,80);
  const installId=safeTelemetryString(body.installId,80);
  const sessionId=safeTelemetryString(body.sessionId,80);
  if(!/^[a-z0-9_.-]{2,80}$/i.test(eventName)) return null;
  if(!/^[a-z0-9_-]{6,80}$/i.test(installId)) return null;
  if(!/^[a-z0-9_-]{6,80}$/i.test(sessionId)) return null;
  const tsRaw=Date.parse(body.timestamp||"");
  const timestamp=Number.isFinite(tsRaw)?new Date(tsRaw).toISOString():new Date().toISOString();
  return {
    timestamp,
    receivedAt:new Date().toISOString(),
    eventName,
    installId,
    sessionId,
    appVersion:safeTelemetryString(body.appVersion,30),
    page:safeTelemetryString(body.page,50),
    platform:safeTelemetryString(body.platform,30),
    displayMode:safeTelemetryString(body.displayMode,30),
    properties:sanitizeTelemetryProperties(body.properties)
  };
}

async function rotateTelemetryIfNeeded(){
  try{
    const st=await fs.stat(TELEMETRY_FILE);
    if(st.size<TELEMETRY_ROTATE_BYTES) return;
    await fs.rm(TELEMETRY_ARCHIVE_FILE,{force:true}).catch(()=>{});
    await fs.rename(TELEMETRY_FILE,TELEMETRY_ARCHIVE_FILE);
  }catch(e){
    if(e?.code!=="ENOENT") console.error("[telemetry rotate]",e);
  }
}

async function appendTelemetry(event){
  try{
    await ensureTelemetryDir();
    await rotateTelemetryIfNeeded();
    await fs.appendFile(TELEMETRY_FILE,JSON.stringify(event)+"\n","utf8");
  }catch(e){
    // Telemetry must never affect the app.
    console.error("[telemetry write]",e?.message||e);
  }
}

async function readTelemetryEvents(){
  await ensureTelemetryDir();
  const files=[TELEMETRY_ARCHIVE_FILE,TELEMETRY_FILE];
  const out=[];
  for(const f of files){
    try{
      const raw=await fs.readFile(f,"utf8");
      for(const line of raw.split(/\n/)){
        if(!line.trim()) continue;
        try{out.push(JSON.parse(line))}catch{}
      }
    }catch(e){
      if(e?.code!=="ENOENT") console.error("[telemetry read]",e);
    }
  }
  out.sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));
  return out.slice(-100000);
}

function adminAuthorized(req){
  const password=process.env.ANALYTICS_ADMIN_PASSWORD||"";
  if(!password) return false;
  const auth=req.headers.authorization||"";
  if(!auth.startsWith("Basic ")) return false;
  try{
    const decoded=Buffer.from(auth.slice(6),"base64").toString("utf8");
    const i=decoded.indexOf(":");
    const user=i>=0?decoded.slice(0,i):"";
    const pass=i>=0?decoded.slice(i+1):"";
    const a=Buffer.from(pass);
    const b=Buffer.from(password);
    return user==="admin" && a.length===b.length && crypto.timingSafeEqual(a,b);
  }catch{return false}
}

function requireAdmin(req,res,next){
  if(!process.env.ANALYTICS_ADMIN_PASSWORD){
    return res.status(503).type("text").send(
      "Analytics dashboard is not configured. Set Railway variable ANALYTICS_ADMIN_PASSWORD, redeploy, then open /admin again."
    );
  }
  if(!adminAuthorized(req)){
    res.set("WWW-Authenticate",'Basic realm="My AR Shelf Analytics"');
    return res.status(401).send("Authentication required.");
  }
  next();
}


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
  const normalized=normalizeISBN(isbn);

  // 1) Open Library direct ISBN endpoint.
  try {
    const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(normalized)}&jscmd=data&format=json`);
    if (r.ok) {
      const j = await r.json();
      const d = j[`ISBN:${normalized}`];
      if (d?.title) {
        return {
          title:d.title||null,
          author:Array.isArray(d.authors)?d.authors.map(a=>a.name).filter(Boolean).join(", "):null,
          cover:d.cover?.medium||d.cover?.small||null,
          pages:d.number_of_pages||null,
          metadataSource:"Open Library"
        };
      }
    }
  } catch {}

  // 2) Open Library search index. This sometimes has ISBN metadata when api/books does not.
  try {
    const r=await fetch(`https://openlibrary.org/search.json?isbn=${encodeURIComponent(normalized)}&limit=5&fields=title,author_name,isbn,cover_i,number_of_pages_median`);
    if(r.ok){
      const j=await r.json();
      const docs=Array.isArray(j.docs)?j.docs:[];
      const exact=docs.find(d=>Array.isArray(d.isbn) && d.isbn.map(normalizeISBN).includes(normalized)) || (docs.length===1?docs[0]:null);
      if(exact?.title){
        return {
          title:exact.title||null,
          author:Array.isArray(exact.author_name)?exact.author_name.filter(Boolean).join(", "):null,
          cover:exact.cover_i?`https://covers.openlibrary.org/b/id/${exact.cover_i}-M.jpg`:null,
          pages:exact.number_of_pages_median||null,
          metadataSource:"Open Library"
        };
      }
    }
  } catch {}

  // 3) Google Books fallback. Display metadata only; never AR values.
  try {
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),7000);
    const r=await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(normalized)}&maxResults=5`,{signal:c.signal});
    clearTimeout(t);
    if(r.ok){
      const j=await r.json();
      const items=Array.isArray(j.items)?j.items:[];
      for(const item of items){
        const v=item?.volumeInfo||{};
        if(!v.title) continue;
        const ids=Array.isArray(v.industryIdentifiers)
          ? v.industryIdentifiers.map(x=>normalizeISBN(x?.identifier||"")).filter(Boolean)
          : [];
        if(ids.length && !ids.includes(normalized)) continue;
        return {
          title:v.title||null,
          author:Array.isArray(v.authors)?v.authors.filter(Boolean).join(", "):null,
          cover:v.imageLinks?.thumbnail||v.imageLinks?.smallThumbnail||null,
          pages:v.pageCount||null,
          metadataSource:"Google Books"
        };
      }
      if(items.length===1 && items[0]?.volumeInfo?.title){
        const v=items[0].volumeInfo;
        return {
          title:v.title||null,
          author:Array.isArray(v.authors)?v.authors.filter(Boolean).join(", "):null,
          cover:v.imageLinks?.thumbnail||v.imageLinks?.smallThumbnail||null,
          pages:v.pageCount||null,
          metadataSource:"Google Books"
        };
      }
    }
  } catch {}

  return null;
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

function parseBookfinderIdentity(text=""){
  const lines=String(text)
    .replace(/\u00a0/g," ")
    .split(/\r?\n/)
    .map(x=>x.trim())
    .filter(Boolean);

  const qi=lines.findIndex(x=>/AR Quiz No\./i.test(x));
  if(qi<0) return {title:null,author:null};

  const bad=/^(title|author|interest level|book level|relevance|rating|search results|sort by|page \d+ of \d+|next|previous)$/i;
  const candidates=[];
  for(let i=qi-1;i>=0 && candidates.length<8;i--){
    const x=lines[i];
    if(!x || bad.test(x)) continue;
    if(/^(IL:|BL:|AR Pts:|AR Quiz Types:)/i.test(x)) continue;
    if(/^\d+$/.test(x)) continue;
    candidates.push(x);
  }

  // Nearest useful line is generally author, then title.
  const author=candidates[0]||null;
  const title=candidates[1]||null;
  return {title,author};
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


async function ensureParentBookfinderSession(page){
  // Match a parent's normal Bookfinder session instead of relying on the
  // Student state produced by direct Advanced Search navigation.
  try{
    const redirect=encodeURIComponent("/advanced.aspx?client=PBQN");
    await page.goto(`https://www.arbookfind.com/UserType.aspx?RedirectURL=${redirect}`,{
      waitUntil:"domcontentloaded",timeout:15000
    });

    let selected=false;
    for(const sel of [
      'input[value="Parent" i]',
      'label:has-text("Parent")',
      'text=Parent'
    ]){
      const loc=page.locator(sel).first();
      if(await loc.count() && await loc.isVisible().catch(()=>false)){
        await loc.click().catch(()=>{});
        selected=true;
        break;
      }
    }

    if(selected){
      await page.waitForTimeout(250);
      if(/UserType\.aspx/i.test(page.url())){
        for(const sel of [
          'input[type="submit"]',
          'button[type="submit"]',
          'button:has-text("Continue")',
          'input[value*="Continue" i]'
        ]){
          const btn=page.locator(sel).first();
          if(await btn.count() && await btn.isVisible().catch(()=>false)){
            await Promise.all([
              page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{}),
              btn.click()
            ]);
            break;
          }
        }
      }
    }

    if(!/advanced\.aspx/i.test(page.url())){
      await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
    }

    const text=await page.locator("body").innerText().catch(()=>"");
    if(/\bParent\b/i.test(text) && !/\bStudent\b/i.test(text)) return "parent";
    if(/\bStudent\b/i.test(text)) return "student";
    return "unknown";
  }catch(e){
    console.warn("[parent session]",e?.message||e);
    await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000}).catch(()=>{});
    return "unknown";
  }
}

async function submitSearch(page,input) {
  // Important: Bookfinder's Advanced Search form has multiple controls.
  // Pressing Enter can trigger a different/default action. Mimic the manual flow:
  // fill ISBN, then click the visible Search button in the SAME form.
  const form=input.locator('xpath=ancestor::form[1]');
  if(await form.count()){
    const selectors=[
      'input[type="submit"][value="Search" i]',
      'button[type="submit"]:has-text("Search")',
      'input[type="submit"][value*="Search" i]',
      'button:has-text("Search")',
      'input[type="image"]'
    ];
    for(const sel of selectors){
      const items=form.locator(sel);
      const count=await items.count();
      for(let i=0;i<count;i++){
        const btn=items.nth(i);
        if(await btn.isVisible().catch(()=>false) && await btn.isEnabled().catch(()=>false)){
          const meta={
            method:"button",
            selector:sel,
            index:i,
            id:await btn.getAttribute("id").catch(()=>null),
            name:await btn.getAttribute("name").catch(()=>null),
            value:await btn.getAttribute("value").catch(()=>null)
          };
          await Promise.all([
            page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{}),
            btn.click()
          ]);
          await page.waitForTimeout(650);
          return meta;
        }
      }
    }
  }

  // Only as a last resort use Enter; diagnostics will make that visible.
  await Promise.all([
    page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{}),
    input.press("Enter")
  ]);
  await page.waitForTimeout(650);
  return {method:"enter-fallback"};
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
  const normalized=normalizeISBN(isbn);
  const out=[];

  function add(candidate){
    const n=normalizeISBN(candidate);
    if((n.length===10||n.length===13) && n!==normalized && !out.includes(n)){
      out.push(n);
    }
  }

  // A) Best case: resolve the edition to its Open Library work, then enumerate editions.
  try{
    const edition=await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(normalized)}.json`);
    const workKey=edition?.works?.[0]?.key;
    if(workKey){
      const editions=await fetchJson(`https://openlibrary.org${workKey}/editions.json?limit=100`);
      for(const e of editions?.entries||[]){
        for(const candidate of [...(e.isbn_13||[]),...(e.isbn_10||[])]) add(candidate);
      }
    }
  }catch{}

  // B) Fallback: Open Library's search index may know the ISBN family even when
  // /isbn/{isbn}.json has no edition record. Collect ISBNs from exact ISBN hits.
  try{
    const search=await fetchJson(
      `https://openlibrary.org/search.json?isbn=${encodeURIComponent(normalized)}&limit=10&fields=isbn,title,author_name`
    );
    for(const doc of search?.docs||[]){
      const ids=Array.isArray(doc.isbn)?doc.isbn:[];
      // Prefer docs that explicitly contain the scanned ISBN. If OL returns only
      // one doc for the ISBN query, accept its ISBN family as well.
      const exact=ids.map(normalizeISBN).includes(normalized);
      if(exact || (search?.docs||[]).length===1){
        for(const candidate of ids) add(candidate);
      }
    }
  }catch{}

  // Try likely equivalents first and cap requests to stay polite/reasonable.
  const ten=isbn13To10(normalized);
  if(ten){
    const i=out.indexOf(ten);
    if(i>0){out.splice(i,1);out.unshift(ten)}
    else if(i<0) out.unshift(ten);
  }

  return out.slice(0,30);
}
async function searchBookfinderExactISBN(page,isbn){
  await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
  const input=await findISBNInput(page);
  if(!input) return null;

  await input.click({clickCount:3}).catch(()=>{});
  await input.fill("");
  await input.type(isbn,{delay:30});
  const submitMeta=await submitSearch(page,input);
  await page.waitForTimeout(600);

  let searchText=await page.locator("body").innerText().catch(()=>"");
  const resultCount=parseBookfinderResultCount(searchText);
  const hasAR=/AR Quiz No\./i.test(searchText);

  // Definitive no-result page.
  if((resultCount===0 || /No results found\./i.test(searchText)) && !hasAR){
    return {found:false,diagnostics:{
      isbn,submitMeta,resultCount,hasAR,
      resultLinks:await page.locator('a[href*="bookdetail.aspx" i]').count().catch(()=>0),
      preview:searchText.slice(0,700)
    }};
  }

  const verifiedOnSearch=textContainsISBN(searchText,isbn);
  const uniqueISBNSearchResult=(resultCount===1 && hasAR);
  const exactLink=await findExactResultLink(page,isbn);
  const singleDetailLink=await getSingleBookDetailLink(page);
  let text=searchText;

  if(exactLink){
    await exactLink.click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(450);
    text=await page.locator("body").innerText().catch(()=>searchText);
  }else if(singleDetailLink && (verifiedOnSearch || uniqueISBNSearchResult)){
    await singleDetailLink.click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(450);
    text=await page.locator("body").innerText().catch(()=>searchText);
  }

  // If the result row had the AR fields but the detail page does not, keep the row.
  if(!/AR Quiz No\./i.test(text) && hasAR) text=searchText;
  if(!/AR Quiz No\./i.test(text)) {
    return {found:false,diagnostics:{
      isbn,submitMeta,resultCount,hasAR:false,
      resultLinks:await page.locator('a[href*="bookdetail.aspx" i]').count().catch(()=>0),
      preview:text.slice(0,700)
    }};
  }

  // Critical v4.5 change:
  // an exact ISBN query returning exactly one AR result is accepted even if
  // Bookfinder does not print the edition ISBN in the result text.
  if(!(verifiedOnSearch || textContainsISBN(text,isbn) || uniqueISBNSearchResult)){
    return {found:false,diagnostics:{
      isbn,submitMeta,resultCount,hasAR:true,reason:"unverified_multiple_or_ambiguous",
      preview:searchText.slice(0,700)
    }};
  }

  const ar=parseAR(text,isbn,page.url());
  ar.matchBasis="related_edition_isbn";
  ar.matchedISBN=isbn;
  return {
    found:true,
    ar,
    diagnostics:{
      isbn,submitMeta,resultCount,hasAR:true,
      acceptedBy:verifiedOnSearch||textContainsISBN(text,isbn)?"visible_isbn":"unique_exact_isbn_search"
    }
  };
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


function collectISBNsFromText(text=""){
  const matches=String(text).toUpperCase().match(/[0-9X][0-9X\-\s]{8,20}[0-9X]/g)||[];
  const out=[];
  for(const m of matches){
    const n=normalizeISBN(m);
    if((n.length===10||n.length===13) && !out.includes(n)) out.push(n);
  }
  return out.slice(0,50);
}



async function findQuickSearchInput(page){
  const inputs=page.locator('input[type="text"],input:not([type])');
  const count=await inputs.count();
  let best=null,bestScore=-999;

  for(let i=0;i<count;i++){
    const el=inputs.nth(i);
    if(!await el.isVisible().catch(()=>false) || !await el.isEnabled().catch(()=>false)) continue;
    const info=await el.evaluate(node=>{
      const attrs=[
        node.id||"",node.name||"",node.placeholder||"",node.getAttribute("aria-label")||""
      ].join(" ");
      let nearby="";
      let p=node.parentElement;
      for(let n=0;n<4 && p;n++,p=p.parentElement) nearby+=" "+(p.innerText||"");
      return {attrs,nearby:nearby.slice(0,1200)};
    }).catch(()=>({attrs:"",nearby:""}));

    const s=(info.attrs+" "+info.nearby).toLowerCase();
    let score=0;
    if(/keycode/.test(s)) score-=100;
    if(/quick search/.test(s)) score+=30;
    if(/\b(search|keyword|query)\b/.test(info.attrs.toLowerCase())) score+=20;
    if(/\b(title|author|series|publisher|isbn)\b/.test(info.attrs.toLowerCase())) score-=15;
    if(score>bestScore){best=el;bestScore=score;}
  }
  return bestScore>-50?best:null;
}

async function submitQuickSearch(page,input){
  // First look for a Search control in the nearest container that says Quick Search.
  let container=null;
  for(const xpath of [
    'xpath=ancestor::div[contains(translate(.,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"quick search")][1]',
    'xpath=ancestor::td[contains(translate(.,"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"quick search")][1]',
    'xpath=ancestor::form[1]'
  ]){
    const loc=input.locator(xpath);
    if(await loc.count()){container=loc.first();break;}
  }
  if(container){
    for(const sel of [
      'input[type="submit"][value="Search" i]',
      'button[type="submit"]:has-text("Search")',
      'input[type="submit"][value*="Search" i]',
      'button:has-text("Search")'
    ]){
      const items=container.locator(sel);
      const count=await items.count();
      for(let i=0;i<count;i++){
        const btn=items.nth(i);
        if(await btn.isVisible().catch(()=>false) && await btn.isEnabled().catch(()=>false)){
          const meta={
            method:"quick-button",
            selector:sel,
            index:i,
            id:await btn.getAttribute("id").catch(()=>null),
            name:await btn.getAttribute("name").catch(()=>null),
            value:await btn.getAttribute("value").catch(()=>null)
          };
          await Promise.all([
            page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{}),
            btn.click()
          ]);
          await page.waitForTimeout(650);
          return meta;
        }
      }
    }
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{}),
    input.press("Enter")
  ]);
  await page.waitForTimeout(650);
  return {method:"quick-enter-fallback"};
}

async function searchBookfinderQuickByISBN(page,isbn){
  // This mirrors the simple search a user performs from Bookfinder's main page.
  // Some books (notably the Cora test case) are returned there even when
  // Advanced Search's ISBN field says "No results found."
  await page.goto("https://www.arbookfind.com/default.aspx?client=PBQN",{
    waitUntil:"domcontentloaded",timeout:15000
  });

  const input=await findQuickSearchInput(page);
  if(!input) return null;

  await input.click({clickCount:3}).catch(()=>{});
  await input.fill("");
  await input.type(isbn,{delay:35});
  const submitMeta=await submitQuickSearch(page,input);

  const searchText=await page.locator("body").innerText().catch(()=>"");
  const resultCount=parseBookfinderResultCount(searchText);
  const hasAR=/AR Quiz No\./i.test(searchText);

  const diagnostics=await diagnosticSnapshot(page,{
    searchedISBN:isbn,
    searchMode:"quick",
    submitMeta,
    fieldValue:await input.inputValue().catch(()=>""),
    inferredIdentity:parseBookfinderIdentity(searchText)
  });

  if(resultCount!==1 || !hasAR) return {found:false,diagnostics};

  const identity=parseBookfinderIdentity(searchText);
  let text=searchText;
  const detail=await getSingleBookDetailLink(page);
  if(detail){
    await detail.click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(500);
    const detailText=await page.locator("body").innerText().catch(()=>"");
    if(/AR Quiz No\./i.test(detailText)) text=detailText;
  }

  const ar=parseAR(text,isbn,page.url());
  return {
    found:true,
    ar,
    identity,
    diagnostics,
    matchBasis:"quick_isbn_unique"
  };
}

function parseBookfinderResultCount(text=""){
  const s=String(text);
  // Typical Bookfinder heading: "Title 1 - 1 of 1"
  const m=s.match(/Title\s+\d+\s*-\s*\d+\s+of\s+(\d+)/i);
  if(m) return Number(m[1]);
  if(/Search Results/i.test(s) && /no results|no books|did not match|no matches/i.test(s)) return 0;
  return null;
}

async function uniqueBookDetailHrefs(page){
  const links=page.locator('a[href*="bookdetail.aspx" i]');
  const count=await links.count();
  const out=[];
  for(let i=0;i<count;i++){
    const href=await links.nth(i).getAttribute("href").catch(()=>null);
    if(href && !out.includes(href)) out.push(href);
  }
  return out;
}

async function getSingleBookDetailLink(page){
  const links=page.locator('a[href*="bookdetail.aspx" i]');
  const hrefs=await uniqueBookDetailHrefs(page);
  if(hrefs.length!==1) return null;
  const count=await links.count();
  for(let i=0;i<count;i++){
    const href=await links.nth(i).getAttribute("href").catch(()=>null);
    if(href===hrefs[0]) return links.nth(i);
  }
  return null;
}

async function diagnosticSnapshot(page,extra={}){
  const text=await page.locator("body").innerText().catch(()=>"");
  return {
    url:page.url(),
    title:await page.title().catch(()=>""),
    containsQuiz:/AR Quiz No\./i.test(text),
    containsATOS:/ATOS Book Level|Book Level|\bBL\b/i.test(text),
    isbns:collectISBNsFromText(text),
    resultLinks:await page.locator('a[href*="bookdetail.aspx" i]').count().catch(()=>0),
    resultCount:parseBookfinderResultCount(text),
    uniqueDetailLinks:(await uniqueBookDetailHrefs(page).catch(()=>[])).length,
    textPreview:text.slice(0,2200),
    ...extra
  };
}

async function performLookup(isbn,{refresh=false}={}) {
  const hit=cache.get(isbn);
  const cacheComplete=Boolean(hit?.value?.title && hit?.value?.author);
  if(!refresh && hit && cacheComplete && Date.now()-hit.time<CACHE_TTL_MS) {
    return {...hit.value,cached:true};
  }

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
    const bookfinderRole=await ensureParentBookfinderSession(page);
    const input=await findISBNInput(page);
    await input.click({clickCount:3}).catch(()=>{});
    await input.fill("");
    await input.type(isbn,{delay:35});
    const submitMeta=await submitSearch(page,input);
    await page.waitForTimeout(700);
    let searchText=await page.locator("body").innerText();
    const isbnDiagnostics=await diagnosticSnapshot(page,{
      searchedISBN:isbn,
      submitMeta,
      fieldValue:await input.inputValue().catch(()=>""),
      bookfinderRole,
      inferredIdentity:parseBookfinderIdentity(await page.locator("body").innerText().catch(()=>""))
    });
    let text=searchText;

    const resultCount=parseBookfinderResultCount(searchText);
    const searchHasAR=/AR Quiz No\./i.test(searchText);
    const bib=await bibPromise;
    const bfIdentity=parseBookfinderIdentity(searchText);

    // A manual ISBN search on Bookfinder can return exactly one valid book while the
    // result card itself omits the ISBN. The diagnostics proved this happens.
    // Because this page was produced by an exact ISBN query, one unique result + AR fields
    // is sufficient evidence to accept the result as the ISBN-search match.
    const uniqueISBNSearchResult=(resultCount===1 && searchHasAR);

    // Only call it "no result" when the result page itself says zero/no results AND
    // there are no AR fields. Avoid broad text matching before inspecting the result page.
    if((resultCount===0 || (
        resultCount===null &&
        /no results|no books|did not match|no matches/i.test(searchText)
      )) && !searchHasAR){

      // First try the mathematically equivalent ISBN-10 for a 978 ISBN-13.
      // Some Bookfinder records index one representation but not the other.
      const equivalent10=isbn13To10(isbn);
      if(equivalent10){
        try{
          const eqResult=await searchBookfinderExactISBN(page,equivalent10);
          if(eqResult?.found){
            const eqAR=eqResult.ar;
            isbnDiagnostics.equivalentISBNAttempt=eqResult.diagnostics;
            const value={
              ...eqAR,
              isbn,
              scannedISBN:isbn,
              title:bib?.title||null,
              author:bib?.author||null,
              cover:bib?.cover||null,
              pages:bib?.pages||null,
              metadataSource:bib?.metadataSource||"AR Bookfinder",
              arSource:"AR Bookfinder",
              matchBasis:"equivalent_isbn",
              matchedISBN:equivalent10,
              lookedUpAt:new Date().toISOString()
            };
            cache.set(isbn,{time:Date.now(),value});
            return value;
          }else if(eqResult?.diagnostics){
            isbnDiagnostics.equivalentISBNAttempt=eqResult.diagnostics;
          }
        }catch(eqErr){
          console.warn("[ISBN-10 fallback]",eqErr?.message||eqErr);
        }
      }

      // Then mirror the simple Bookfinder search used by a person on the main page.
      try{
        const quick=await searchBookfinderQuickByISBN(page,isbn);
        if(quick?.found){
          const value={
            ...quick.ar,
            isbn,
            title:bib?.title||quick.identity?.title||null,
            author:bib?.author||quick.identity?.author||null,
            cover:bib?.cover||null,
            pages:bib?.pages||null,
            metadataSource:(bib?.title||bib?.author)?(bib.metadataSource||"Open Library"):"AR Bookfinder",
            arSource:"AR Bookfinder",
            matchBasis:"quick_isbn_unique",
            lookedUpAt:new Date().toISOString()
          };
          cache.set(isbn,{time:Date.now(),value});
          return value;
        }
        if(quick?.diagnostics) isbnDiagnostics.quickSearch=quick.diagnostics;
      }catch(quickErr){
        console.warn("[quick ISBN fallback]",quickErr?.message||quickErr);
      }

      // v5.2: Try the strict title+author match BEFORE enumerating sibling editions.
      // The beta data exposed two false-negative families:
      // (1) newer reprints whose AR quiz is indexed under an older edition, and
      // (2) exact ISBNs that Bookfinder intermittently reports as no-result.
      // A unique title+author match resolves both quickly and conservatively; sibling
      // ISBN enumeration remains as the fallback for books such as Cora where it is needed.
      if(bib?.title && bib?.author){
        try{
          await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
          const fallback=await searchBookfinderByTitleAuthor(page,bib.title,bib.author);
          isbnDiagnostics.titleAuthorAttempt={
            title:bib.title,
            author:bib.author,
            found:Boolean(fallback)
          };
          if(fallback){
            const ar=parseAR(fallback.text,isbn,fallback.pageUrl);
            const value={
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
            cache.set(isbn,{time:Date.now(),value});
            return value;
          }
        }catch(fallbackErr){
          isbnDiagnostics.titleAuthorAttempt={
            title:bib.title,
            author:bib.author,
            found:false,
            error:String(fallbackErr?.message||fallbackErr).slice(0,220)
          };
          console.warn("[title-author fallback]",fallbackErr?.message||fallbackErr);
        }
      }

      // If the unique title+author path does not work, try alternate ISBNs for the
      // same Open Library work. Preserve the proven Cora behavior.
      try{
        const siblings=await lookupSiblingISBNs(isbn);
        isbnDiagnostics.siblingCandidates=siblings.slice(0,12);
        isbnDiagnostics.siblingAttempts=[];
        for(const sibling of siblings){
          const siblingResult=await searchBookfinderExactISBN(page,sibling);
          if(siblingResult?.diagnostics){
            if(isbnDiagnostics.siblingAttempts.length<12) isbnDiagnostics.siblingAttempts.push(siblingResult.diagnostics);
          }
          if(siblingResult?.found){
            const siblingAR=siblingResult.ar;
            const siblingBib=bib||await lookupBibliographic(sibling).catch(()=>null);
            const value={
              ...siblingAR,
              isbn,
              scannedISBN:isbn,
              title:siblingBib?.title||bfIdentity.title||null,
              author:siblingBib?.author||bfIdentity.author||null,
              cover:siblingBib?.cover||null,
              pages:siblingBib?.pages||null,
              metadataSource:siblingBib?.metadataSource||"AR Bookfinder",
              arSource:"AR Bookfinder",
              matchBasis:"related_edition_isbn",
              matchedISBN:sibling,
              lookedUpAt:new Date().toISOString()
            };
            cache.set(isbn,{time:Date.now(),value});
            return value;
          }
        }
      }catch(editionErr){
        console.warn("[related-edition fallback]",editionErr?.message||editionErr);
      }

      const e=new Error("No AR result was found by ISBN, related editions, or a unique title/author match.");
      e.code="NOT_FOUND";e.bib=bib;e.diagnostics=isbnDiagnostics;throw e;
    }

    const verifiedOnSearch=textContainsISBN(searchText,isbn);
    const exactLink=await findExactResultLink(page,isbn);
    const singleDetailLink=await getSingleBookDetailLink(page);

    if(exactLink){
      await exactLink.click();
      await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
      await page.waitForTimeout(500);
      text=await page.locator("body").innerText();
    }else if(singleDetailLink && (verifiedOnSearch || uniqueISBNSearchResult)){
      await singleDetailLink.click();
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
        e.code="PARSE_CHANGED";e.diagnostics=isbnDiagnostics;throw e;
      }
    }

    // Accuracy guard: prefer exact ISBN verification. If Bookfinder returns AR data
    // for the work but does not expose the edition ISBN, allow a strict title+author
    // match against bibliographic metadata. This is labelled honestly as title_author.
    const verified=verifiedOnSearch || textContainsISBN(text,isbn);
    let matchBasis="isbn";

    if(!verified){
      if(uniqueISBNSearchResult){
        // The result came directly from an exact ISBN query and Bookfinder returned
        // exactly one AR record. Bookfinder simply did not print the ISBN in the result text.
        matchBasis="isbn_search_unique";
      }else{
        const titleAuthorVerified=
          bib?.title && bib?.author &&
          (titleAuthorMatch(bib.title,bib.author,searchText) ||
           titleAuthorMatch(bib.title,bib.author,text));

        if(titleAuthorVerified){
          matchBasis="title_author";
        }else{
          const e=new Error("Bookfinder returned AR data, but the result could not be tied to this book by ISBN, a unique ISBN-search result, or a clear title/author match.");
          e.code="ISBN_MISMATCH";e.bib=bib;e.diagnostics=isbnDiagnostics;throw e;
        }
      }
    }

    const ar=parseAR(text,isbn,page.url());
    ar.matchBasis=matchBasis;
    const value={
      ...ar,
      title:bib?.title||bfIdentity.title||null,
      author:bib?.author||bfIdentity.author||null,
      cover:bib?.cover||null,
      pages:bib?.pages||null,
      metadataSource:bib?.title||bib?.author ? (bib.metadataSource||"Open Library") : "AR Bookfinder"
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


app.post("/api/telemetry",async(req,res)=>{
  try{
    const approx=Buffer.byteLength(JSON.stringify(req.body||{}),"utf8");
    if(approx>MAX_TELEMETRY_BODY_BYTES) return res.status(413).end();
    const event=normalizeTelemetryEvent(req.body);
    if(!event) return res.status(400).end();
    // Send the response immediately; persistence is best-effort.
    res.status(204).end();
    void appendTelemetry(event);
  }catch{
    // Telemetry failure should not surface to the product.
    if(!res.headersSent) res.status(204).end();
  }
});

app.get("/api/admin/analytics",requireAdmin,async(_req,res)=>{
  const events=await readTelemetryEvents();
  res.json({ok:true,events});
});

function analyticsAdminHtml(){
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>My AR Shelf Analytics</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#20221f;background:#f4f5f2}
*{box-sizing:border-box}body{margin:0}.wrap{max-width:1280px;margin:auto;padding:24px}
h1{margin:0 0 4px;font-size:28px}.sub{color:#6c7069;margin-bottom:20px}
.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0 20px}
select,button{font:inherit;padding:9px 12px;border:1px solid #d8dbd4;border-radius:10px;background:#fff}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:20px}
.card{background:#fff;border:1px solid #e2e4de;border-radius:14px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.035)}
.metric b{display:block;font-size:27px;margin-bottom:4px}.metric span{color:#73776f;font-size:13px}
.section{margin:20px 0}.section h2{font-size:19px;margin:0 0 10px}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px 7px;border-bottom:1px solid #eceee9;vertical-align:top}th{color:#666b63;font-size:12px}
.barrow{display:grid;grid-template-columns:145px 1fr 55px;gap:8px;align-items:center;margin:8px 0;font-size:13px}.bar{height:9px;background:#eceee9;border-radius:999px;overflow:hidden}.bar>i{display:block;height:100%;background:#687d68}
.good{color:#35623b}.bad{color:#9a4038}.muted{color:#73776f}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.timeline{max-height:420px;overflow:auto}.timeline div{padding:7px 0;border-bottom:1px solid #eee;font-size:12px}
.clickable{cursor:pointer;text-decoration:underline;text-decoration-style:dotted}
@media(max-width:850px){.grid{grid-template-columns:1fr 1fr}.cols{grid-template-columns:1fr}}
</style>
</head>
<body><div class="wrap">
<h1>My AR Shelf Analytics</h1>
<div class="sub">Anonymous beta usage, product behavior, reliability and lookup quality. No recovery codes or child names are collected.</div>
<div class="toolbar">
<select id="window"><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="9999">All time</option></select>
<select id="version"><option value="">All versions</option></select>
<button id="refresh">Refresh</button>
</div>
<div id="metrics" class="grid"></div>
<div class="section"><h2>Activation & uptake</h2><div class="card" id="funnel"></div></div>
<div class="cols">
<div class="section"><h2>Behavior</h2><div class="card"><div id="behavior"></div></div></div>
<div class="section"><h2>Reliability</h2><div class="card"><div id="reliability"></div></div></div>
</div>
<div class="section"><h2>Fix verification</h2><div class="card" id="fixVerification"></div></div>
<div class="section"><h2>Book / lookup quality</h2><div class="card" id="books"></div></div>
<div class="section"><h2>Recent sessions</h2><div class="card" id="sessions"></div></div>
<div class="section"><h2>Selected installation timeline</h2><div class="card timeline" id="timeline"><span class="muted">Click an installation in Recent sessions.</span></div></div>
</div>
<script>
let raw=[];
const $=id=>document.getElementById(id);
const uniq=a=>new Set(a).size;
function pct(a,b){return b?Math.round(a/b*100):0}
function dt(e){return new Date(e.timestamp)}
function filtered(){
 const days=Number($("window").value), v=$("version").value;
 const cutoff=Date.now()-days*86400000;
 return raw.filter(e=>dt(e).getTime()>=cutoff && (!v||e.appVersion===v));
}
function quantile(vals,q){
 const a=vals.filter(Number.isFinite).sort((x,y)=>x-y); if(!a.length)return null;
 return a[Math.min(a.length-1,Math.floor((a.length-1)*q))];
}
function countBy(events,keyFn){
 const m=new Map(); for(const e of events){const k=keyFn(e)||"unknown";m.set(k,(m.get(k)||0)+1)} return [...m.entries()].sort((a,b)=>b[1]-a[1]);
}
function bars(rows){
 if(!rows.length)return '<span class="muted">No data yet.</span>';
 const max=Math.max(...rows.map(x=>x[1]),1);
 return rows.slice(0,12).map(([k,n])=>'<div class="barrow"><span>'+esc(k)+'</span><div class="bar"><i style="width:'+Math.round(n/max*100)+'%"></i></div><b>'+n+'</b></div>').join('');
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function render(){
 const ev=filtered();
 const installs=uniq(ev.map(e=>e.installId)), sessions=uniq(ev.map(e=>e.sessionId));
 const captureEvents=ev.filter(e=>e.eventName==="book_captured");
 const scans=captureEvents.length;
 const uniqueBooks=uniq(captureEvents.map(e=>e.properties?.isbn).filter(Boolean));
 const lookups=ev.filter(e=>["lookup_success","lookup_no_ar","lookup_error","lookup_timeout"].includes(e.eventName));
 const terminalTechnical=lookups.filter(e=>["lookup_success","lookup_no_ar"].includes(e.eventName));
 const ok=lookups.filter(e=>e.eventName==="lookup_success").length;
 const technicalSuccess=pct(terminalTechnical.length,lookups.length);
 const arCoverage=pct(ok,terminalTechnical.length);
 const backup=ev.filter(e=>["backup_success","backup_failed"].includes(e.eventName));
 const backupOK=backup.filter(e=>e.eventName==="backup_success").length;
 const activeDaysByInstall=new Map();
 for(const e of ev){const d=e.timestamp.slice(0,10);if(!activeDaysByInstall.has(e.installId))activeDaysByInstall.set(e.installId,new Set());activeDaysByInstall.get(e.installId).add(d)}
 const returning=[...activeDaysByInstall.values()].filter(s=>s.size>=2).length;
 $("metrics").innerHTML=[
 ["Active installs",installs],
 ["Sessions",sessions],
 ["Books captured",scans],
 ["Unique books",uniqueBooks],
 ["Technical lookup success",technicalSuccess+"%"],
 ["AR coverage",arCoverage+"%"],
 ["Backup success",pct(backupOK,backup.length)+"%"],
 ["Lookup errors",lookups.filter(e=>["lookup_error","lookup_timeout"].includes(e.eventName)).length]
 ].map(([l,v])=>'<div class="card metric"><b>'+v+'</b><span>'+l+'</span></div>').join('');

 const byInstall=new Map();
 for(const e of ev){if(!byInstall.has(e.installId))byInstall.set(e.installId,[]);byInstall.get(e.installId).push(e)}
 const total=byInstall.size;
 const stages=[
  ["Opened app",x=>x.some(e=>e.eventName==="app_open")],
  ["Captured ≥1 book",x=>x.some(e=>e.eventName==="book_captured")],
  ["Captured ≥5 books",x=>x.filter(e=>e.eventName==="book_captured").length>=5],
  ["Created a child",x=>x.some(e=>e.eventName==="child_created")],
  ["Used Kids screen",x=>x.some(e=>e.eventName==="page_view"&&e.properties?.page==="kidsPage")],
  ["Successful online backup",x=>x.some(e=>e.eventName==="backup_success")],
  ["Saved recovery code",x=>x.some(e=>["recovery_code_copy","recovery_code_download"].includes(e.eventName))],
  ["Returned another day",x=>new Set(x.map(e=>e.timestamp.slice(0,10))).size>=2]
 ];
 $("funnel").innerHTML='<table><tr><th>Milestone</th><th>Installs</th><th>% of active installs</th></tr>'+
 stages.map(([name,fn])=>{const n=[...byInstall.values()].filter(fn).length;return '<tr><td>'+name+'</td><td>'+n+'</td><td>'+pct(n,total)+'%</td></tr>'}).join('')+'</table>';

 const behaviorEvents=ev.filter(e=>!["app_open","lookup_started","lookup_success","lookup_no_ar","lookup_error","lookup_timeout","backup_started","backup_success"].includes(e.eventName));
 $("behavior").innerHTML='<b>Top actions</b>'+bars(countBy(behaviorEvents,e=>e.eventName))+
 '<div style="height:12px"></div><b>Pages viewed</b>'+bars(countBy(ev.filter(e=>e.eventName==="page_view"),e=>e.properties?.page));

 const durations=lookups.map(e=>Number(e.properties?.durationMs)).filter(Number.isFinite);
 const match=ev.filter(e=>e.eventName==="lookup_success");
 const errs=ev.filter(e=>["lookup_error","lookup_timeout"].includes(e.eventName));
 const retriedKeys=new Set(ev.filter(e=>e.eventName==="lookup_retry"&&e.properties?.isbn).map(e=>e.installId+"|"+e.properties.isbn));
 const recoveredKeys=new Set(ev.filter(e=>e.eventName==="lookup_success"&&e.properties?.isbn).map(e=>e.installId+"|"+e.properties.isbn));
 const retryRecovered=[...retriedKeys].filter(k=>recoveredKeys.has(k)).length;
 $("reliability").innerHTML=
 '<table><tr><th>Metric</th><th>Value</th></tr>'+
 '<tr><td>Lookup p50</td><td>'+(quantile(durations,.5)?.toFixed(0)||"—")+' ms</td></tr>'+
 '<tr><td>Lookup p90</td><td>'+(quantile(durations,.9)?.toFixed(0)||"—")+' ms</td></tr>'+
 '<tr><td>Lookup p95</td><td>'+(quantile(durations,.95)?.toFixed(0)||"—")+' ms</td></tr>'+
 '<tr><td>Retries that later succeeded</td><td>'+retryRecovered+' / '+retriedKeys.size+'</td></tr>'+
 '<tr><td>Timeouts</td><td>'+ev.filter(e=>e.eventName==="lookup_timeout"||e.properties?.errorCode==="LOOKUP_TIMEOUT").length+'</td></tr>'+
 '<tr><td>Backup failures</td><td>'+ev.filter(e=>e.eventName==="backup_failed").length+'</td></tr>'+
 '<tr><td>Restore failures</td><td>'+ev.filter(e=>e.eventName==="restore_failed").length+'</td></tr></table>'+
 '<div style="height:12px"></div><b>Successful match paths</b>'+bars(countBy(match,e=>e.properties?.matchBasis||"isbn"))+
 '<div style="height:12px"></div><b>Error types</b>'+bars(countBy(errs,e=>e.properties?.errorCode||e.properties?.errorType||"error"));

 const releaseQueued=ev.filter(e=>e.eventName==="unresolved_books_recheck_queued");
 const releaseCompleted=ev.filter(e=>e.eventName==="historical_book_recheck_completed");
 const releaseMap=new Map();
 for(const e of releaseQueued){
   const release=e.properties?.release||e.appVersion||"unknown";
   if(!releaseMap.has(release))releaseMap.set(release,{release,eligible:0,retested:0,fixed:0,confirmed:0,resolvedNoAr:0,stillFailing:0});
   releaseMap.get(release).eligible+=Number(e.properties?.count)||0;
 }
 for(const e of releaseCompleted){
   const release=e.properties?.release||e.properties?.toVersion||e.appVersion||"unknown";
   if(!releaseMap.has(release))releaseMap.set(release,{release,eligible:0,retested:0,fixed:0,confirmed:0,resolvedNoAr:0,stillFailing:0});
   const r=releaseMap.get(release);r.retested++;
   const outcome=e.properties?.outcome;
   if(outcome==="fixed_to_ar")r.fixed++;
   else if(outcome==="confirmed_no_ar")r.confirmed++;
   else if(outcome==="resolved_to_no_ar")r.resolvedNoAr++;
   else if(outcome==="still_error"||outcome==="still_unknown")r.stillFailing++;
 }
 const releaseRows=[...releaseMap.values()].sort((a,b)=>String(b.release).localeCompare(String(a.release)));
 const fixSummary=releaseRows.length
   ? '<table><tr><th>Release</th><th>Eligible</th><th>Retested</th><th>Fixed → AR</th><th>Confirmed no AR</th><th>Error → no AR</th><th>Still failing</th><th>Waiting</th></tr>'+ 
     releaseRows.map(r=>'<tr><td>'+esc(r.release)+'</td><td>'+r.eligible+'</td><td>'+r.retested+'</td><td class="good">'+r.fixed+'</td><td>'+r.confirmed+'</td><td>'+r.resolvedNoAr+'</td><td class="'+(r.stillFailing?'bad':'')+'">'+r.stillFailing+'</td><td>'+Math.max(0,r.eligible-r.retested)+'</td></tr>').join('')+'</table>'
   : '<span class="muted">No release rechecks recorded yet.</span>';
 const recentFixes=releaseCompleted.slice().sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp))).slice(0,20);
 const fixDetails=recentFixes.length
   ? '<div style="height:14px"></div><b>Recent historical rechecks</b><table><tr><th>ISBN</th><th>Old</th><th>New</th><th>Version</th><th>Outcome</th></tr>'+ 
     recentFixes.map(e=>'<tr><td class="mono">'+esc(e.properties?.isbn||"")+'</td><td>'+esc(e.properties?.oldStatus||"—")+'</td><td>'+esc(e.properties?.newStatus||"—")+'</td><td>'+esc((e.properties?.fromVersion||"earlier")+' → '+(e.properties?.toVersion||e.appVersion||""))+'</td><td>'+esc(e.properties?.outcome||"")+'</td></tr>').join('')+'</table>'
   : '';
 $("fixVerification").innerHTML=fixSummary+fixDetails;

 const scansByISBN=new Map();
 for(const e of ev.filter(e=>e.properties?.isbn)){
   const isbn=e.properties.isbn;
   if(!scansByISBN.has(isbn))scansByISBN.set(isbn,{isbn,captured:0,ok:0,noar:0,errors:0,alt:0});
   const r=scansByISBN.get(isbn);
   if(e.eventName==="book_captured")r.captured++;
   if(e.eventName==="lookup_success"){r.ok++;if(e.properties?.matchBasis&&e.properties.matchBasis!=="isbn")r.alt++}
   if(e.eventName==="lookup_no_ar")r.noar++;
   if(["lookup_error","lookup_timeout"].includes(e.eventName))r.errors++;
 }
 const bookRows=[...scansByISBN.values()].sort((a,b)=>(b.errors+b.noar+b.captured)-(a.errors+a.noar+a.captured)).slice(0,30);
 $("books").innerHTML='<table><tr><th>ISBN</th><th>Captured</th><th>AR success</th><th>No AR</th><th>Errors</th><th>Alt-edition hits</th></tr>'+
 bookRows.map(r=>'<tr><td class="mono">'+esc(r.isbn)+'</td><td>'+r.captured+'</td><td>'+r.ok+'</td><td>'+r.noar+'</td><td>'+r.errors+'</td><td>'+r.alt+'</td></tr>').join('')+'</table>';

 const sessMap=new Map();
 for(const e of ev){if(!sessMap.has(e.sessionId))sessMap.set(e.sessionId,[]);sessMap.get(e.sessionId).push(e)}
 const sess=[...sessMap.values()].map(x=>({
   sessionId:x[0].sessionId, installId:x[0].installId, last:x[x.length-1].timestamp,
   events:x.length, scans:x.filter(e=>e.eventName==="book_captured").length,
   errors:x.filter(e=>["lookup_error","lookup_timeout","backup_failed","restore_failed"].includes(e.eventName)).length
 })).sort((a,b)=>b.last.localeCompare(a.last)).slice(0,30);
 $("sessions").innerHTML='<table><tr><th>Last seen</th><th>Installation</th><th>Events</th><th>Scans</th><th>Errors</th></tr>'+
 sess.map(s=>'<tr><td>'+new Date(s.last).toLocaleString()+'</td><td><span class="clickable mono" data-install="'+esc(s.installId)+'">'+esc(s.installId.slice(0,10))+'…</span></td><td>'+s.events+'</td><td>'+s.scans+'</td><td>'+s.errors+'</td></tr>').join('')+'</table>';
 document.querySelectorAll("[data-install]").forEach(x=>x.onclick=()=>renderTimeline(x.dataset.install));
}
function renderTimeline(id){
 const ev=filtered().filter(e=>e.installId===id).slice(-250).reverse();
 $("timeline").innerHTML=ev.length?ev.map(e=>'<div><b>'+new Date(e.timestamp).toLocaleString()+'</b> · '+esc(e.eventName)+' · <span class="muted">'+esc(e.page||"")+'</span><br><span class="mono">'+esc(JSON.stringify(e.properties||{}))+'</span></div>').join(''):'No events.';
}
async function load(){
 const r=await fetch("/api/admin/analytics");
 if(!r.ok){$("metrics").innerHTML='<div class="card">Could not load analytics.</div>';return}
 const j=await r.json();raw=j.events||[];
 const versions=[...new Set(raw.map(e=>e.appVersion).filter(Boolean))].sort().reverse();
 $("version").innerHTML='<option value="">All versions</option>'+versions.map(v=>'<option>'+esc(v)+'</option>').join('');
 render();
}
$("window").onchange=render;$("version").onchange=render;$("refresh").onclick=load;load();
</script></body></html>`;
}

app.get("/admin",requireAdmin,(_req,res)=>res.type("html").send(analyticsAdminHtml()));

app.get("/health",(_req,res)=>res.status(200).json({ok:true,service:"scan-ar",version:"5.4.0",time:new Date().toISOString()}));
app.get("/api/lookup-status",(_req,res)=>res.json({
  ok:true,
  version:"5.4.0",
  bookfinderUrl:BOOKFINDER_URL,
  browserInitialized:Boolean(browserPromise),
  cacheEntries:cache.size
}));

app.get("/api/status",async(_req,res)=>{
  try{const b=await getBrowser();res.json({ok:true,browserConnected:b.isConnected(),cacheEntries:cache.size})}
  catch(e){res.status(503).json({ok:false,browserConnected:false,error:String(e?.message||e)})}
});

app.get("/api/meta/:isbn",async(req,res)=>{
  const isbn=normalizeISBN(req.params.isbn);
  if(!isValidISBN(isbn)) return res.status(400).json({error:"Invalid ISBN."});
  const bib=await lookupBibliographic(isbn);
  if(!bib) return res.status(404).json({isbn,title:null,author:null});
  return res.json({isbn,...bib});
});


const TOTAL_LOOKUP_TIMEOUT_MS=45000;

function withLookupDeadline(promise,ms=TOTAL_LOOKUP_TIMEOUT_MS){
  let timer;
  const timeout=new Promise((_,reject)=>{
    timer=setTimeout(()=>{
      const e=new Error("AR lookup took too long. Please retry.");
      e.code="LOOKUP_TIMEOUT";
      reject(e);
    },ms);
  });
  return Promise.race([promise,timeout]).finally(()=>clearTimeout(timer));
}

app.get("/api/ar/:isbn",async(req,res)=>{
  const isbn=normalizeISBN(req.params.isbn);
  if(!isValidISBN(isbn))return res.status(400).json({error:"Enter a valid ISBN-10 or ISBN-13 (checksum failed)."});
  try{
    const result=await withLookupDeadline(performLookup(isbn,{refresh:req.query.refresh==="1"}));
    return res.json(result);
  }catch(e){
    console.error(`[lookup ${isbn}]`,e);
    if(e.code==="LOOKUP_TIMEOUT"){
      return res.status(504).json({
        isbn,
        error:"AR lookup took too long. Please retry.",
        code:"LOOKUP_TIMEOUT",
        lookedUpAt:new Date().toISOString()
      });
    }
    if(e.code==="NOT_FOUND"){
      const bib=e.bib||await lookupBibliographic(isbn);
      return res.status(404).json({
        error:e.message,reason:"no_ar_record",
        diagnostics:e?.diagnostics||null,isbn,
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
    const diagnostics=e?.diagnostics||null;
    if(e.code==="ISBN_MISMATCH")return res.status(502).json({...fallback,error:e.message,code:e.code,diagnostics});
    if(e.code==="PARSE_CHANGED")return res.status(502).json({...fallback,error:e.message,code:e.code,diagnostics});
    return res.status(502).json({...fallback,error:"AR Bookfinder lookup failed.",detail:String(e?.message||e),diagnostics});
  }
});

const port=Number(process.env.PORT||3000);
const server=app.listen(port,"0.0.0.0",()=>console.log(`My AR Shelf v5.4.0 listening on ${port}`));
async function shutdown(){
  console.log("Shutting down…");server.close();
  if(browserPromise){try{(await browserPromise).close()}catch{}}
  process.exit(0);
}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
