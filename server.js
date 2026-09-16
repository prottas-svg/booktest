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
          const eqAR=await searchBookfinderExactISBN(page,equivalent10);
          if(eqAR){
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

      // Next try alternate ISBNs for the same book/work reported by Open Library.
      try{
        const siblings=await lookupSiblingISBNs(isbn);
        isbnDiagnostics.siblingCandidates=siblings.slice(0,12);
        for(const sibling of siblings){
          const siblingAR=await searchBookfinderExactISBN(page,sibling);
          if(siblingAR){
            const siblingBib=bib||await lookupBibliographic(sibling).catch(()=>null);
            return {
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
          }
        }
      }catch(editionErr){
        console.warn("[related-edition fallback]",editionErr?.message||editionErr);
      }

      // If no sibling ISBN works, fall back to a strict title+author search.
      if(bib?.title && bib?.author){
        try{
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

app.get("/health",(_req,res)=>res.status(200).json({ok:true,service:"scan-ar",version:"4.4.0",time:new Date().toISOString()}));
app.get("/api/lookup-status",(_req,res)=>res.json({
  ok:true,
  version:"4.4.0",
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
const server=app.listen(port,"0.0.0.0",()=>console.log(`My AR Shelf v4.4.0 listening on ${port}`));
async function shutdown(){
  console.log("Shutting down…");server.close();
  if(browserPromise){try{(await browserPromise).close()}catch{}}
  process.exit(0);
}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
