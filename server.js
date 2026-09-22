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
const NO_AR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map();
const noArCache = new Map();

const EDITION_FAMILY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const editionFamilyCache = new Map();
const THIN_FAMILY_CACHE_MS = 60 * 60 * 1000;

const BACKUP_DIR = process.env.BACKUP_DIR || "/data/backups";
const MAX_BACKUP_BYTES = 2 * 1024 * 1024;

const TELEMETRY_DIR = process.env.TELEMETRY_DIR || "/data/telemetry";
const TELEMETRY_FILE = path.join(TELEMETRY_DIR,"events.ndjson");
const TELEMETRY_ARCHIVE_FILE = path.join(TELEMETRY_DIR,"events-previous.ndjson");
const REGRESSION_FILE = path.join(TELEMETRY_DIR,"regression-cases.json");
const SERVER_VERIFY_STATE_FILE = path.join(TELEMETRY_DIR,"server-verification-state.json");
const SERVER_VERSION = "6.4.5";
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


async function readRegressionCases(){
  await ensureTelemetryDir();
  try{
    const raw=await fs.readFile(REGRESSION_FILE,"utf8");
    const parsed=JSON.parse(raw);
    return parsed && typeof parsed==="object" ? parsed : {};
  }catch(e){
    if(e?.code!=="ENOENT") console.error("[regression read]",e);
    return {};
  }
}

async function writeRegressionCases(cases){
  await ensureTelemetryDir();
  const temp=REGRESSION_FILE+".tmp";
  await fs.writeFile(temp,JSON.stringify(cases,null,2),"utf8");
  await fs.rename(temp,REGRESSION_FILE);
}

let regressionWriteChain=Promise.resolve();
function rememberRegressionCase(event){
  const isbn=normalizeISBN(event?.properties?.isbn||"");
  if(!isValidISBN(isbn)) return;
  regressionWriteChain=regressionWriteChain.then(async()=>{
    const cases=await readRegressionCases();
    const prior=cases[isbn]||{};
    cases[isbn]={
      isbn,
      firstSeenAt:prior.firstSeenAt||event.timestamp||new Date().toISOString(),
      lastSeenAt:event.timestamp||new Date().toISOString(),
      expectedQuizNumber:event?.properties?.quizNumber||prior.expectedQuizNumber||null,
      source:prior.source||"observed_lookup_success"
    };
    await writeRegressionCases(cases);
  }).catch(e=>console.error("[regression write]",e?.message||e));
}

async function backfillRegressionCases(){
  const events=await readTelemetryEvents();
  for(const e of events){
    if(e.eventName==="lookup_success" && e.properties?.isbn) rememberRegressionCase(e);
  }
  await regressionWriteChain;
}

function sanitizeServerTelemetryProperties(input){
  const out=sanitizeTelemetryProperties(input);
  if(!input || typeof input!=="object") return out;
  const longTextKeys=new Set([
    "metadataTitle","metadataAuthor","rejectionReason","queryTrace",
    "siblingCandidates","exactSearchSummary","equivalentSearchSummary",
    "quickSearchSummary","titleAuthorSummary","siblingSearchSummary",
    "probeBodyText","probeHtmlSnippet","probeBookLinks",
    "openLibraryDirect","openLibrarySearch","googleBooksExact"
  ]);
  for(const key of longTextKeys){
    if(input[key]!=null){
      const max=key==="queryTrace"?9000:
        (key==="probeBodyText"||key==="probeHtmlSnippet"?6500:
        (key==="openLibraryDirect"||key==="openLibrarySearch"||key==="googleBooksExact"?5000:2400));
      out[key]=safeTelemetryString(input[key],max);
    }
  }
  return out;
}

function serverTelemetryEvent(eventName,properties={},sessionId="server"){
  const timestamp=new Date().toISOString();
  return {
    timestamp,
    receivedAt:timestamp,
    eventName,
    installId:"server_verification",
    sessionId,
    appVersion:SERVER_VERSION.replace(/\\.0$/, ""),
    page:"server",
    platform:"server",
    displayMode:"server",
    properties:sanitizeServerTelemetryProperties(properties)
  };
}

function summarizeVerificationAttempt(label,d={}){
  if(!d || typeof d!=="object") return null;
  const submit=d?.submitMeta?.method||d?.submitMeta?.submitMethod||null;
  const inferred=d?.inferredIdentity||{};
  return {
    label,
    isbn:d.isbn||d.searchedISBN||null,
    resultCount:d.resultCount??null,
    hasAR:d.hasAR??d.containsQuiz??false,
    resultLinks:d.resultLinks??null,
    uniqueDetailLinks:d.uniqueDetailLinks??null,
    submitMethod:submit,
    acceptedBy:d.acceptedBy||null,
    reason:d.reason||null,
    error:d.error||null,
    identityTitle:inferred?.title||null,
    identityAuthor:inferred?.author||null
  };
}

function buildVerificationDiagnosticProperties(isbn,error,result=null){
  const d=error?.diagnostics||{};
  const bib=error?.bib||null;
  const attempts=[];

  const exact=summarizeVerificationAttempt("exact_isbn",d);
  if(exact) attempts.push(exact);

  if(d.equivalentISBNAttempt){
    const a=summarizeVerificationAttempt("equivalent_isbn",d.equivalentISBNAttempt);
    if(a) attempts.push(a);
  }else if(d.equivalentISBNError){
    attempts.push({label:"equivalent_isbn",error:d.equivalentISBNError});
  }

  if(d.quickSearch){
    const a=summarizeVerificationAttempt("quick_isbn",d.quickSearch);
    if(a) attempts.push(a);
  }else if(d.quickSearchError){
    attempts.push({label:"quick_isbn",error:d.quickSearchError});
  }

  if(d.titleAuthorAttempt){
    attempts.push({
      label:"title_author",
      title:d.titleAuthorAttempt.title||bib?.title||null,
      author:d.titleAuthorAttempt.author||bib?.author||null,
      found:Boolean(d.titleAuthorAttempt.found),
      error:d.titleAuthorAttempt.error||null
    });
  }

  const siblings=Array.isArray(d.siblingAttempts)?d.siblingAttempts:[];
  for(const a0 of siblings){
    const a=summarizeVerificationAttempt("related_edition_isbn",a0);
    if(a) attempts.push(a);
  }

  const concise=a=>{
    const bits=[a.label];
    if(a.isbn) bits.push(a.isbn);
    if(a.title) bits.push(`title="${a.title}"`);
    if(a.author) bits.push(`author="${a.author}"`);
    if(a.resultCount!=null) bits.push(`results=${a.resultCount}`);
    if(a.hasAR!=null) bits.push(`AR=${a.hasAR?"yes":"no"}`);
    if(a.acceptedBy) bits.push(`accepted=${a.acceptedBy}`);
    if(a.found!=null) bits.push(`found=${a.found?"yes":"no"}`);
    if(a.reason) bits.push(`reason=${a.reason}`);
    if(a.error) bits.push(`error=${String(a.error).slice(0,180)}`);
    return bits.join(" · ");
  };

  const siblingCandidates=Array.isArray(d.siblingCandidates)?d.siblingCandidates:[];
  return {
    isbn,
    metadataTitle:bib?.title||d?.inferredIdentity?.title||null,
    metadataAuthor:bib?.author||d?.inferredIdentity?.author||null,
    metadataSource:bib?.metadataSource||null,
    finalStatus:result?"found":(error?.code==="NOT_FOUND"?"no_ar":"error"),
    errorCode:error?.code||error?.name||null,
    rejectionReason:error?.message||null,
    exactSearchSummary:attempts.filter(a=>a.label==="exact_isbn").map(concise).join(" | "),
    equivalentSearchSummary:attempts.filter(a=>a.label==="equivalent_isbn").map(concise).join(" | "),
    quickSearchSummary:attempts.filter(a=>a.label==="quick_isbn").map(concise).join(" | "),
    titleAuthorSummary:attempts.filter(a=>a.label==="title_author").map(concise).join(" | "),
    siblingCandidates:siblingCandidates.join(", "),
    siblingSearchSummary:attempts.filter(a=>a.label==="related_edition_isbn").map(concise).join(" | "),
    siblingLookupError:d.siblingLookupError||null,
    queryTrace:JSON.stringify(attempts),
    matchedISBN:result?.matchedISBN||null,
    matchBasis:result?.matchBasis||null,
    quizNumber:result?.quizNumber||null,
    atos:result?.atos??null
  };
}

async function readBackupVerificationCandidates(){
  await ensureBackupDir();
  const candidates=new Map();
  let files=[];
  try{files=await fs.readdir(BACKUP_DIR,{withFileTypes:true})}catch(e){
    if(e?.code!=="ENOENT") console.error("[verification backups]",e);
    return candidates;
  }
  for(const entry of files){
    if(!entry.isFile() || !entry.name.endsWith(".json")) continue;
    try{
      const raw=await fs.readFile(path.join(BACKUP_DIR,entry.name),"utf8");
      const record=JSON.parse(raw);
      const books=record?.data?.books;
      if(!books || typeof books!=="object") continue;
      for(const book of Object.values(books)){
        const isbn=normalizeISBN(book?.isbn||"");
        if(!isValidISBN(isbn)) continue;
        if(book.lookupStatus!=="no_ar" && book.lookupStatus!=="error") continue;
        if(!candidates.has(isbn)) candidates.set(isbn,{isbn,statuses:new Set(),backupIds:new Set()});
        const c=candidates.get(isbn);
        c.statuses.add(book.lookupStatus);
        c.backupIds.add(entry.name);
      }
    }catch(e){
      console.error("[verification backup file]",entry.name,e?.message||e);
    }
  }
  return candidates;
}

let serverVerificationRunning=false;
let serverVerificationLatest=null;
let serverVerificationProgress=null;


const BOOKFINDER_PROBE_TARGETS=[
  {isbn:"9780746074855",label:"Ancient Greeks older edition"},
  {isbn:"9781416991649",label:"Trouble at the Arcade older edition"},
  {isbn:"9780448479170",label:"Known-good regression control"}
];

const METADATA_PROBE_ISBNS=[
  "9781665930802","9781665930819","9781665930826","9781665930833"
];

function compactProbeJson(value,max=4800){
  try{return JSON.stringify(value).slice(0,max)}catch{return String(value||"").slice(0,max)}
}

async function probeExactBookfinderISBN(isbn,label){
  const browser=await getBrowser();
  const context=await newBookfinderContext(browser);
  context.setDefaultTimeout(12000);
  const started=Date.now();
  try{
    const page=await context.newPage();
    await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:25000});
    const bookfinderRole=await ensureParentBookfinderSession(page);
    const input=await findISBNInput(page);
    const inputMeta={
      id:await input.getAttribute("id").catch(()=>null),
      name:await input.getAttribute("name").catch(()=>null),
      type:await input.getAttribute("type").catch(()=>null),
      placeholder:await input.getAttribute("placeholder").catch(()=>null)
    };
    await input.click({clickCount:3}).catch(()=>{});
    await input.fill("");
    await input.fill(isbn);
    const submitMeta=await submitSearch(page,input);
    await page.waitForTimeout(250);

    const bodyText=await page.locator("body").innerText().catch(()=>"");
    const bodyHtml=await page.locator("body").innerHTML().catch(()=>"");
    const snap=await diagnosticSnapshot(page,{
      searchedISBN:isbn,
      submitMeta,
      fieldValue:await input.inputValue().catch(()=>""),
      bookfinderRole
    });
    const hrefs=await uniqueBookDetailHrefs(page).catch(()=>[]);
    const quizIdx=bodyHtml.search(/AR Quiz No\.?/i);
    const isbnIdx=bodyHtml.indexOf(isbn);
    const htmlIdx=quizIdx>=0?quizIdx:isbnIdx;
    const htmlSnippet=htmlIdx>=0
      ? bodyHtml.slice(Math.max(0,htmlIdx-1800),htmlIdx+4200)
      : bodyHtml.slice(0,6000);

    return {
      probeISBN:isbn,
      probeLabel:label,
      durationMs:Date.now()-started,
      role:bookfinderRole,
      finalUrl:page.url(),
      inputMeta:compactProbeJson(inputMeta,1200),
      submitMeta:compactProbeJson(submitMeta,1200),
      resultCount:snap.resultCount,
      containsQuiz:snap.containsQuiz,
      containsATOS:snap.containsATOS,
      resultLinks:snap.resultLinks,
      uniqueDetailLinks:snap.uniqueDetailLinks,
      visibleISBNs:(snap.isbns||[]).join(", "),
      probeBookLinks:hrefs.join(" | "),
      probeBodyText:bodyText.slice(0,6500),
      probeHtmlSnippet:htmlSnippet
    };
  }catch(e){
    return {
      probeISBN:isbn,
      probeLabel:label,
      durationMs:Date.now()-started,
      probeError:e?.message||String(e),
      errorCode:e?.code||e?.name||"ERROR"
    };
  }finally{
    await context.close().catch(()=>{});
  }
}

async function probeMetadataSources(isbn){
  const result={isbn};
  try{
    const r=await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=data&format=json`);
    result.openLibraryDirect=compactProbeJson(r.ok?await r.json():{status:r.status});
  }catch(e){result.openLibraryDirect=compactProbeJson({error:e?.message||String(e)})}

  try{
    const r=await fetch(`https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=10&fields=title,author_name,isbn,first_publish_year,key`);
    result.openLibrarySearch=compactProbeJson(r.ok?await r.json():{status:r.status});
  }catch(e){result.openLibrarySearch=compactProbeJson({error:e?.message||String(e)})}

  try{
    const c=new AbortController();
    const t=setTimeout(()=>c.abort(),8000);
    const r=await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}&maxResults=10`,{signal:c.signal});
    clearTimeout(t);
    result.googleBooksExact=compactProbeJson(r.ok?await r.json():{status:r.status});
  }catch(e){result.googleBooksExact=compactProbeJson({error:e?.message||String(e)})}
  return result;
}

async function runDiagnosticProbes(runId){
  for(const target of BOOKFINDER_PROBE_TARGETS){
    const result=await probeExactBookfinderISBN(target.isbn,target.label);
    await appendTelemetry(serverTelemetryEvent("bookfinder_exact_probe",result,runId));
  }
  for(const isbn of METADATA_PROBE_ISBNS){
    const result=await probeMetadataSources(isbn);
    await appendTelemetry(serverTelemetryEvent("metadata_source_probe",result,runId));
  }
}

async function runServerVerification({reason="manual",force=false}={}){
  if(serverVerificationRunning) return {started:false,running:true,latest:serverVerificationLatest};
  await ensureTelemetryDir();
  if(!force){
    try{
      const prev=JSON.parse(await fs.readFile(SERVER_VERIFY_STATE_FILE,"utf8"));
      if(prev?.serverVersion===SERVER_VERSION && prev?.finishedAt){
        serverVerificationLatest=prev;
        return {started:false,alreadyRan:true,latest:prev};
      }
    }catch(e){if(e?.code!=="ENOENT") console.error("[verification state]",e)}
  }

  serverVerificationRunning=true;
  const runId="server_verify_"+Date.now().toString(36);
  const startedAt=new Date().toISOString();
  const summary={serverVersion:SERVER_VERSION,runId,reason,startedAt,finishedAt:null,historicalTotal:0,regressionTotal:0,historicalFixedToAr:0,historicalConfirmedNoAr:0,historicalResolvedToNoAr:0,historicalStillError:0,regressionPassed:0,regressionFailed:0};
  serverVerificationLatest=summary;

  try{
    await backfillRegressionCases();
    const historical=await readBackupVerificationCandidates();
    const regressions=await readRegressionCases();
    summary.historicalTotal=historical.size;
    summary.regressionTotal=Object.keys(regressions).length;
    await appendTelemetry(serverTelemetryEvent("server_verification_started",{
      reason,
      historicalTotal:summary.historicalTotal,
      regressionTotal:summary.regressionTotal,
      serverVersion:SERVER_VERSION
    },runId));

    const combined=new Map();
    for(const [isbn,c] of historical) combined.set(isbn,{isbn,historical:c,regression:regressions[isbn]||null});
    for(const [isbn,r] of Object.entries(regressions)){
      if(!combined.has(isbn)) combined.set(isbn,{isbn,historical:null,regression:r});
      else combined.get(isbn).regression=r;
    }

    const items=[...combined.values()];
    const progressItems=items.map(item=>({
      isbn:item.isbn,
      historical:Boolean(item.historical),
      regression:Boolean(item.regression),
      priorStatuses:item.historical?[...item.historical.statuses]:[],
      status:"queued",
      startedAt:null,
      finishedAt:null,
      resultStatus:null,
      outcome:null,
      errorCode:null,
      durationMs:null
    }));
    serverVerificationProgress={
      runId,serverVersion:SERVER_VERSION,reason,startedAt,finishedAt:null,
      total:progressItems.length,
      historicalTotal:summary.historicalTotal,
      regressionTotal:summary.regressionTotal,
      queued:progressItems.length,checking:0,completed:0,remaining:progressItems.length,
      items:progressItems
    };
    let next=0;
    const worker=async()=>{
      while(true){
        const n=next++;
        if(n>=items.length) return;
        const item=items[n];
        await waitForUserLookupsToFinish();
        const progressItem=serverVerificationProgress?.items?.[n];
        if(progressItem){
          progressItem.status="checking";
          progressItem.startedAt=new Date().toISOString();
          serverVerificationProgress.queued=Math.max(0,serverVerificationProgress.queued-1);
          serverVerificationProgress.checking++;
        }
        const t0=Date.now();
        let resultStatus="error", outcome="still_error", result=null, errorCode=null, lookupError=null;
        try{
          try{
            result=await withLookupDeadline(performLookup(item.isbn,{refresh:true}));
          }catch(firstError){
            // A failure inside a few seconds means the lookup never really ran
            // (cold page, browser restart). Give it one clean retry before
            // recording an error against the book.
            if(firstError?.code==="NOT_FOUND" || Date.now()-t0>6000) throw firstError;
            await new Promise(r=>setTimeout(r,1500));
            result=await withLookupDeadline(performLookup(item.isbn,{refresh:true}));
            if(serverVerificationProgress?.items?.[n]) serverVerificationProgress.items[n].retried=true;
          }
          resultStatus="found";
          outcome="fixed_to_ar";
        }catch(e){
          lookupError=e;
          errorCode=e?.code||e?.name||"ERROR";
          if(e?.code==="NOT_FOUND"){
            resultStatus="no_ar";
            const priorStatuses=item.historical?[...item.historical.statuses]:[];
            outcome=priorStatuses.includes("error") && !priorStatuses.includes("no_ar") ? "resolved_to_no_ar" : "confirmed_no_ar";
          }
        }

        if(item.historical){
          const diagnosticProps=buildVerificationDiagnosticProperties(item.isbn,lookupError,result);
          diagnosticProps.durationMs=Date.now()-t0;
          diagnosticProps.outcome=outcome;
          await appendTelemetry(serverTelemetryEvent(
            "server_verification_diagnostic",
            diagnosticProps,
            runId
          ));
        }

        if(item.historical){
          if(resultStatus==="found") summary.historicalFixedToAr++;
          else if(outcome==="confirmed_no_ar") summary.historicalConfirmedNoAr++;
          else if(outcome==="resolved_to_no_ar") summary.historicalResolvedToNoAr++;
          else summary.historicalStillError++;
          await appendTelemetry(serverTelemetryEvent("server_historical_recheck_completed",{
            isbn:item.isbn,
            priorStatuses:[...item.historical.statuses],
            affectedBackups:item.historical.backupIds.size,
            resultStatus,
            outcome,
            quizNumber:result?.quizNumber||null,
            atos:result?.atos??null,
            points:result?.points??null,
            matchBasis:result?.matchBasis||null,
            errorCode,
            durationMs:Date.now()-t0,
            serverVersion:SERVER_VERSION
          },runId));
        }

        if(item.regression){
          const passed=resultStatus==="found";
          if(passed) summary.regressionPassed++; else summary.regressionFailed++;
          await appendTelemetry(serverTelemetryEvent("server_regression_recheck_completed",{
            isbn:item.isbn,
            passed,
            resultStatus,
            expectedQuizNumber:item.regression.expectedQuizNumber||null,
            actualQuizNumber:result?.quizNumber||null,
            errorCode,
            durationMs:Date.now()-t0,
            serverVersion:SERVER_VERSION
          },runId));
        }

        if(progressItem){
          progressItem.status="completed";
          progressItem.finishedAt=new Date().toISOString();
          progressItem.resultStatus=resultStatus;
          progressItem.outcome=item.historical?outcome:(resultStatus==="found"?"regression_pass":"regression_fail");
          progressItem.errorCode=errorCode;
          progressItem.durationMs=Date.now()-t0;
          serverVerificationProgress.checking=Math.max(0,serverVerificationProgress.checking-1);
          serverVerificationProgress.completed++;
          serverVerificationProgress.remaining=Math.max(0,serverVerificationProgress.total-serverVerificationProgress.completed);
        }
      }
    };

    // v6.4.5: warm the browser first and stagger the second worker. Proven case:
    // 9780545940221 failed in 1s as the first item of a cold run, then passed on its
    // own with quiz 176430 — a startup race, not a real lookup failure.
    await getBrowser().catch(()=>{});
    await Promise.all([
      worker(),
      (async()=>{await new Promise(r=>setTimeout(r,2000));return worker()})()
    ]);
    // Diagnostic-only probes. No live matching, cache, backup, or library mutation.
    await runDiagnosticProbes(runId);
    summary.finishedAt=new Date().toISOString();
    if(serverVerificationProgress){
      serverVerificationProgress.finishedAt=summary.finishedAt;
      serverVerificationProgress.queued=0;
      serverVerificationProgress.checking=0;
      serverVerificationProgress.remaining=0;
    }
    await appendTelemetry(serverTelemetryEvent("server_verification_finished",summary,runId));
    await fs.writeFile(SERVER_VERIFY_STATE_FILE,JSON.stringify(summary,null,2),"utf8");
    serverVerificationLatest=summary;
    return {started:true,latest:summary};
  }catch(e){
    summary.finishedAt=new Date().toISOString();
    summary.error=String(e?.message||e);
    if(serverVerificationProgress){
      serverVerificationProgress.finishedAt=summary.finishedAt;
      serverVerificationProgress.error=summary.error;
    }
    serverVerificationLatest=summary;
    await appendTelemetry(serverTelemetryEvent("server_verification_failed",{serverVersion:SERVER_VERSION,error:summary.error},runId));
    return {started:true,error:summary.error,latest:summary};
  }finally{
    serverVerificationRunning=false;
  }
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
      args:[
        "--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
        // v6.4.4: trim renderer memory. Proven case: "locator.count: Target crashed"
        // on 9780803740884, i.e. Chromium died mid-lookup on the container.
        "--disable-gpu","--disable-extensions","--disable-background-networking",
        "--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding",
        "--disable-features=TranslateUI,BackForwardCache,AcceptCHFrame",
        "--blink-settings=imagesEnabled=false","--mute-audio","--no-first-run"
      ]
    }).then(b=>{
      // If Chromium dies, drop the handle so the next lookup launches a fresh one
      // instead of every later request failing against a dead browser.
      b.on("disconnected",()=>{browserPromise=undefined;browserCrashes++});
      return b;
    }).catch(err=>{browserPromise=undefined;throw err});
  }
  return browserPromise;
}
let browserCrashes=0;
function isBrowserCrash(e){
  return /target crashed|browser has been closed|browser has disconnected|target closed/i.test(String(e?.message||e));
}
// v6.4.4: one place to build a Bookfinder context, with images/fonts/media blocked.
// Bookfinder's AR fields are text, so the artwork costs memory and time for nothing.
async function newBookfinderContext(browser){
  const context=await browser.newContext({
    viewport:{width:1024,height:768},
    userAgent:"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128 Safari/537.36"
  });
  await context.route("**/*",route=>{
    const type=route.request().resourceType();
    if(type==="image"||type==="media"||type==="font") return route.abort().catch(()=>{});
    return route.continue().catch(()=>{});
  }).catch(()=>{});
  return context;
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
  const interest=firstMatch(normalized,[/Interest Level:[ \t]*([^\n\r]+)/i,/\bIL:?\s*([A-Z]+\+?)/,/Interest Level:?\s*(?!->)([^\n\r]+)/i]);
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


// v6.4.2: wait for Bookfinder's search postback to actually finish.
// Previously the code waited for "domcontentloaded" on the page that was ALREADY
// loaded, so it often read the old, unsubmitted form ~150 ms after clicking.
// That produced PARSE_CHANGED and skipped the other-edition route
// (proven: 9781536208788 returned the bare search form with no results area).
const SEARCH_SETTLED_SRC="AR Quiz No\\.|No results found|Title\\s+\\d+\\s*-\\s*\\d+\\s+of\\s+\\d+";
async function clickAndSettle(page,action){
  const started=Date.now();
  const before=await page.evaluate(()=>{
    window.__arShelfPreSubmit=true;
    return document.body?document.body.innerText:"";
  }).catch(()=>"");
  await action();
  // 1) old document replaced (full postback) OR body changed to show a result state (partial update)
  const replaced=await page.waitForFunction(([src,old])=>{
    const body=document.body?document.body.innerText:"";
    if(!window.__arShelfPreSubmit && document.readyState!=="loading") return true;
    return body!==old && new RegExp(src,"i").test(body);
  },[SEARCH_SETTLED_SRC,before],{timeout:12000,polling:100}).then(()=>true).catch(()=>false);
  // 2) give the result/no-result marker a short grace period to render
  const marker=await page.waitForFunction(src=>new RegExp(src,"i").test(document.body?document.body.innerText:""),
    SEARCH_SETTLED_SRC,{timeout:4000,polling:100}).then(()=>true).catch(()=>false);
  return {replaced,marker,ms:Date.now()-started};
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
          meta.settle=await clickAndSettle(page,()=>btn.click());
          await page.waitForTimeout(150);
          return meta;
        }
      }
    }
  }

  // Only as a last resort use Enter; diagnostics will make that visible.
  await clickAndSettle(page,()=>input.press("Enter"));
  await page.waitForTimeout(150);
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

async function lookupSiblingISBNs(isbn,bib=null){
  const normalized=normalizeISBN(isbn);
  const candidates=new Map();
  let order=0;

  function editionYear(value){
    const m=String(value||"").match(/\b(18|19|20)\d{2}\b/);
    return m?Number(m[0]):null;
  }

  function add(candidate,{year=null,source="unknown"}={}){
    const n=normalizeISBN(candidate);
    if((n.length!==10&&n.length!==13) || n===normalized) return;
    const prior=candidates.get(n);
    const rankYear=Number.isFinite(year)?year:9999;
    if(!prior){
      candidates.set(n,{isbn:n,year:rankYear,source,order:order++});
    }else if(rankYear<prior.year){
      prior.year=rankYear;
      prior.source=source;
    }
  }

  // A) Resolve the scanned edition to its Open Library work and enumerate editions.
  // Older editions are deliberately ranked first: AR quizzes are often attached to
  // the original/older ISBN while a parent scans a later reprint of the same work.
  try{
    const edition=await fetchJson(`https://openlibrary.org/isbn/${encodeURIComponent(normalized)}.json`);
    const workKey=edition?.works?.[0]?.key;
    if(workKey){
      const editions=await fetchJson(`https://openlibrary.org${workKey}/editions.json?limit=100`);
      for(const e of editions?.entries||[]){
        const year=editionYear(e?.publish_date);
        for(const candidate of [...(e.isbn_13||[]),...(e.isbn_10||[])]) add(candidate,{year,source:"work_editions"});
      }
    }
  }catch{}

  // B) Fallback: Open Library's search index may know the ISBN family even when
  // /isbn/{isbn}.json has no edition record.
  try{
    const search=await fetchJson(
      `https://openlibrary.org/search.json?isbn=${encodeURIComponent(normalized)}&limit=10&fields=isbn,title,author_name,first_publish_year`
    );
    for(const doc of search?.docs||[]){
      const ids=Array.isArray(doc.isbn)?doc.isbn:[];
      const exact=ids.map(normalizeISBN).includes(normalized);
      if(exact || (search?.docs||[]).length===1){
        const year=Number(doc?.first_publish_year)||null;
        for(const candidate of ids) add(candidate,{year,source:"search_index"});
      }
    }
  }catch{}

  // C) Reissue discovery by strict bibliographic identity. Some publishers assign a
  // new ISBN to a photographic-cover/reissue while AR remains attached to the
  // older edition. Same-work identifiers are not always linked in Open Library,
  // so search by exact normalized title + author and collect only ISBNs from
  // records that independently match both. These are still only CANDIDATES; every
  // candidate must subsequently return an AR result from Bookfinder.
  if(bib?.title && bib?.author){
    const wantedTitle=normalizeTitleForMatch(bib.title);
    const wantedAuthor=normalizeAuthorForMatch(bib.author);
    const authorTokens=wantedAuthor.split(" ").filter(Boolean);
    const strictIdentity=(title,authors)=>{
      const t=normalizeTitleForMatch(title);
      const a=normalizeAuthorForMatch(Array.isArray(authors)?authors.join(" "):authors);
      if(!wantedTitle || !wantedAuthor || t!==wantedTitle) return false;
      return authorTokens.length>0 && authorTokens.every(tok=>a.includes(tok));
    };

    try{
      const q=`https://openlibrary.org/search.json?title=${encodeURIComponent(bib.title)}&author=${encodeURIComponent(bib.author)}&limit=25&fields=title,author_name,isbn,first_publish_year,publish_year`;
      const search=await fetchJson(q);
      for(const doc of search?.docs||[]){
        if(!strictIdentity(doc?.title,doc?.author_name||[])) continue;
        const years=Array.isArray(doc?.publish_year)?doc.publish_year.filter(Number.isFinite):[];
        const year=Math.min(...years,Number(doc?.first_publish_year)||9999);
        for(const candidate of doc?.isbn||[]) add(candidate,{year:Number.isFinite(year)?year:null,source:"title_author_openlibrary"});
      }
    }catch{}

    try{
      const q=`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(`intitle:${bib.title} inauthor:${bib.author}`)}&maxResults=20`;
      const search=await fetchJson(q);
      for(const item of search?.items||[]){
        const v=item?.volumeInfo||{};
        if(!strictIdentity(v?.title,v?.authors||[])) continue;
        const year=editionYear(v?.publishedDate);
        for(const id of v?.industryIdentifiers||[]) add(id?.identifier,{year,source:"title_author_google_books"});
      }
    }catch{}
  }

  // Mathematical ISBN-10 equivalent remains the first candidate.
  const ten=isbn13To10(normalized);
  if(ten) add(ten,{year:0,source:"isbn10_equivalent"});

  return [...candidates.values()]
    .sort((a,b)=>a.year-b.year || a.order-b.order)
    .map(x=>x.isbn)
    .slice(0,20);
}

async function discoverEditionFamily(isbn,bibPromise){
  const normalized=normalizeISBN(isbn);
  const hit=editionFamilyCache.get(normalized);
  if(hit && Date.now()-hit.time<EDITION_FAMILY_CACHE_TTL_MS){
    return {bib:hit.bib||null,candidates:[...(hit.candidates||[])],cached:true,durationMs:0};
  }

  const started=Date.now();
  let bib=null,candidates=[];
  try{bib=await bibPromise}catch{}
  try{candidates=await lookupSiblingISBNs(normalized,bib)}catch{}

  const seen=new Set();
  candidates=(candidates||[])
    .map(normalizeISBN)
    .filter(x=>(x.length===10||x.length===13)&&x!==normalized&&!seen.has(x)&&seen.add(x))
    .slice(0,20);

  // v6.4.1: a result with no metadata and at most the ISBN-10 equivalent may be a
  // transient Open Library/Google Books failure; cache it for 1 hour, not 7 days.
  const thin=!bib && candidates.length<=1;
  editionFamilyCache.set(normalized,{bib,candidates,time:thin?Date.now()-EDITION_FAMILY_CACHE_TTL_MS+THIN_FAMILY_CACHE_MS:Date.now()});
  return {bib,candidates,cached:false,durationMs:Date.now()-started};
}

async function searchBookfinderExactISBN(page,isbn){
  await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
  const input=await findISBNInput(page);
  if(!input) return null;

  await input.click({clickCount:3}).catch(()=>{});
  await input.fill("");
  await input.fill(isbn);
  const submitMeta=await submitSearch(page,input);
  await page.waitForTimeout(150);

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
    await page.waitForTimeout(100);
    text=await page.locator("body").innerText().catch(()=>searchText);
  }else if(singleDetailLink && (verifiedOnSearch || uniqueISBNSearchResult)){
    await singleDetailLink.click();
    await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
    await page.waitForTimeout(100);
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
  await page.waitForTimeout(150);

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
    await page.waitForTimeout(100);
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
          meta.settle=await clickAndSettle(page,()=>btn.click());
          await page.waitForTimeout(150);
          return meta;
        }
      }
    }
  }

  await clickAndSettle(page,()=>input.press("Enter"));
  await page.waitForTimeout(150);
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
  await input.fill(isbn);
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
    await page.waitForTimeout(100);
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


async function runFallbackBatch(context,tasks){
  const usable=tasks.filter(Boolean);
  if(!usable.length) return null;
  return await new Promise(resolve=>{
    let remaining=usable.length;
    let settled=false;
    const finishMiss=()=>{
      remaining--;
      if(!settled && remaining===0){settled=true;resolve(null)}
    };
    for(const task of usable){
      (async()=>{
        const page=await context.newPage();
        try{
          const result=await task.run(page);
          if(!settled && result){settled=true;resolve({...result,fallbackKind:task.kind})}
        }catch(e){
          try{task.onError?.(e)}catch{}
        }finally{
          await page.close().catch(()=>{});
          finishMiss();
        }
      })().catch(()=>finishMiss());
    }
  });
}

async function runFallbackTasks(context,tasks,batchSize=3){
  for(let i=0;i<tasks.length;i+=batchSize){
    const found=await runFallbackBatch(context,tasks.slice(i,i+batchSize));
    if(found) return found;
  }
  return null;
}

// v6.4.3: per-lookup timing, readable even when the deadline kills the lookup.
const liveTiming=new Map();
function startTiming(isbn){
  if(liveTiming.size>200) liveTiming.clear();
  const t={startedAt:Date.now(),steps:[]};
  t.mark=(label,extra)=>{t.steps.push({step:label,atMs:Date.now()-t.startedAt,...(extra||{})})};
  t.elapsed=()=>Date.now()-t.startedAt;
  liveTiming.set(isbn,t);
  return t;
}

async function performLookup(isbn,{refresh=false}={}) {
  const timing=startTiming(isbn);
  const hit=cache.get(isbn);
  const cacheComplete=Boolean(hit?.value?.title && hit?.value?.author);
  if(!refresh && hit && cacheComplete && Date.now()-hit.time<CACHE_TTL_MS) {
    return {...hit.value,cached:true};
  }
  if(!refresh){
    const miss=noArCache.get(isbn);
    if(miss && Date.now()-miss.time<NO_AR_CACHE_TTL_MS){
      const e=new Error("No AR result was found for the scanned ISBN or any discovered edition ISBN, and no unique title/author fallback matched.");
      e.code="NOT_FOUND";
      e.bib=miss.bib||null;
      e.diagnostics={...(miss.diagnostics||{}),cachedNoAr:true};
      throw e;
    }
  }

  const bibPromise=lookupBibliographic(isbn);
  // Run bibliographic/edition discovery in parallel with the exact scanned-ISBN lookup.
  // The normal success path never waits for this work.
  const editionFamilyPromise=discoverEditionFamily(isbn,bibPromise);
  const browser=await getBrowser();
  timing.mark("browser_ready");
  const context=await newBookfinderContext(browser);
  context.setDefaultTimeout(12000);
  try{
    const page=await context.newPage();
    await page.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:25000});
    const bookfinderRole=await ensureParentBookfinderSession(page);
    const input=await findISBNInput(page);
    await input.click({clickCount:3}).catch(()=>{});
    await input.fill("");
    await input.fill(isbn);
    const submitMeta=await submitSearch(page,input);
    await page.waitForTimeout(150);
    let searchText=await page.locator("body").innerText();
    const isbnDiagnostics=await diagnosticSnapshot(page,{
      searchedISBN:isbn,
      submitMeta,
      fieldValue:await input.inputValue().catch(()=>""),
      bookfinderRole,
      inferredIdentity:parseBookfinderIdentity(await page.locator("body").innerText().catch(()=>""))
    });
    let text=searchText;
    timing.mark("exact_search_read");

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

      const fallbackStartedAt=Date.now();

      // PHASE 2 starts only after the scanned ISBN has failed.
      // Discovery has already been running in parallel, so in the common case
      // the candidate list is ready immediately.
      timing.mark("exact_search_no_result");
      const family=await editionFamilyPromise;
      const bib=family?.bib||await bibPromise.catch(()=>null);
      const siblingCandidates=family?.candidates||[];
      isbnDiagnostics.discovery={
        startedInParallel:true,
        cached:Boolean(family?.cached),
        durationMs:Number(family?.durationMs)||0,
        candidateCount:siblingCandidates.length
      };
      isbnDiagnostics.siblingCandidates=siblingCandidates.slice(0,20);
      isbnDiagnostics.siblingAttempts=[];
      timing.mark("discovery_ready",{candidates:siblingCandidates.length});
      let candidatesStarted=0, candidatesSkippedForTime=0;

      // Every discovered edition is checked as its own exact Bookfinder ISBN query.
      const candidateTasks=siblingCandidates.map(candidate=>({
        kind:"related_edition_isbn",
        run:async p=>{
          if(timing.elapsed()>CANDIDATE_START_CUTOFF_MS){
            candidatesSkippedForTime++;
            return null;
          }
          candidatesStarted++;
          const candidateStartedAt=Date.now();
          const r=await searchBookfinderExactISBN(p,candidate);
          timing.mark("candidate_done",{isbn:candidate,ms:Date.now()-candidateStartedAt,found:Boolean(r?.found)});
          if(r?.diagnostics && isbnDiagnostics.siblingAttempts.length<20){
            isbnDiagnostics.siblingAttempts.push({...r.diagnostics,durationMs:Date.now()-candidateStartedAt});
          }
          if(!r?.found) return null;
          return {ar:r.ar,matchedISBN:candidate,matchBasis:"related_edition_isbn"};
        },
        onError:e=>{
          if(isbnDiagnostics.siblingAttempts.length<20){
            isbnDiagnostics.siblingAttempts.push({isbn:candidate,error:String(e?.message||e).slice(0,220)});
          }
        }
      }));

      let fallback=await runFallbackTasks(context,candidateTasks,2);
      timing.mark("candidates_done",{started:candidatesStarted,skippedForTime:candidatesSkippedForTime});
      isbnDiagnostics.candidateBudget={
        started:candidatesStarted,
        skippedForTime:candidatesSkippedForTime,
        cutoffMs:CANDIDATE_START_CUTOFF_MS
      };
      if(fallback){
        isbnDiagnostics.fallbackDurationMs=Date.now()-fallbackStartedAt;
        const value={
          ...fallback.ar,
          isbn,
          scannedISBN:isbn,
          title:bib?.title||bfIdentity.title||null,
          author:bib?.author||bfIdentity.author||null,
          cover:bib?.cover||null,
          pages:bib?.pages||null,
          metadataSource:bib?.metadataSource||"AR Bookfinder",
          arSource:"AR Bookfinder",
          matchBasis:"related_edition_isbn",
          matchedISBN:fallback.matchedISBN,
          lookedUpAt:new Date().toISOString()
        };
        noArCache.delete(isbn);
        cache.set(isbn,{time:Date.now(),value});
        return value;
      }

      // Looser routes are last-resort fallbacks, only after all discovered ISBNs
      // have been tried independently.
      const looseTasks=[{
        kind:"quick_isbn_unique",
        run:async p=>{
          const q=await searchBookfinderQuickByISBN(p,isbn);
          if(q?.diagnostics) isbnDiagnostics.quickSearch=q.diagnostics;
          if(!q?.found) return null;
          return {ar:q.ar,identity:q.identity,matchBasis:"quick_isbn_unique"};
        },
        onError:e=>{isbnDiagnostics.quickSearchError=String(e?.message||e).slice(0,220)}
      }];

      if(bib?.title && bib?.author){
        looseTasks.push({
          kind:"title_author",
          run:async p=>{
            await p.goto(BOOKFINDER_URL,{waitUntil:"domcontentloaded",timeout:15000});
            const f=await searchBookfinderByTitleAuthor(p,bib.title,bib.author);
            isbnDiagnostics.titleAuthorAttempt={title:bib.title,author:bib.author,found:Boolean(f)};
            if(!f) return null;
            return {ar:parseAR(f.text,isbn,f.pageUrl),matchBasis:"title_author"};
          },
          onError:e=>{isbnDiagnostics.titleAuthorAttempt={title:bib.title,author:bib.author,found:false,error:String(e?.message||e).slice(0,220)}}
        });
      }

      fallback=await runFallbackTasks(context,looseTasks,2);
      if(fallback){
        isbnDiagnostics.fallbackDurationMs=Date.now()-fallbackStartedAt;
        const value={
          ...fallback.ar,
          isbn,
          scannedISBN:isbn,
          title:bib?.title||fallback.identity?.title||bfIdentity.title||null,
          author:bib?.author||fallback.identity?.author||bfIdentity.author||null,
          cover:bib?.cover||null,
          pages:bib?.pages||null,
          metadataSource:(bib?.title||bib?.author)?(bib.metadataSource||"Open Library"):"AR Bookfinder",
          arSource:"AR Bookfinder",
          matchBasis:fallback.matchBasis,
          matchedISBN:fallback.matchedISBN||null,
          lookedUpAt:new Date().toISOString()
        };
        noArCache.delete(isbn);
        cache.set(isbn,{time:Date.now(),value});
        return value;
      }

      isbnDiagnostics.fallbackDurationMs=Date.now()-fallbackStartedAt;
      noArCache.set(isbn,{time:Date.now(),bib,diagnostics:isbnDiagnostics});
      const e=new Error("No AR result was found for the scanned ISBN or any discovered edition ISBN, and no unique title/author fallback matched.");
      e.code="NOT_FOUND";e.bib=bib;e.diagnostics=isbnDiagnostics;throw e;
    }

    const verifiedOnSearch=textContainsISBN(searchText,isbn);
    const exactLink=await findExactResultLink(page,isbn);
    const singleDetailLink=await getSingleBookDetailLink(page);

    if(exactLink){
      await exactLink.click();
      await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
      await page.waitForTimeout(100);
      text=await page.locator("body").innerText();
    }else if(singleDetailLink && (verifiedOnSearch || uniqueISBNSearchResult)){
      await singleDetailLink.click();
      await page.waitForLoadState("domcontentloaded",{timeout:12000}).catch(()=>{});
      await page.waitForTimeout(100);
      text=await page.locator("body").innerText();
    }

    if(!/AR Quiz No\./i.test(text)){
      // Some search-result layouts contain the AR fields directly.
      // If navigation removed them, fall back to the verified search text.
      // v6.4.1: the same fallback applies to isbn_search_unique results, where the
      // row omits the ISBN. Proven case: 9781416991649 showed quiz 137100 in the row,
      // but the detail page lacked "AR Quiz No." and the lookup failed as PARSE_CHANGED.
      if((verifiedOnSearch || uniqueISBNSearchResult) && /AR Quiz No\./i.test(searchText)) {
        isbnDiagnostics.usedSearchRowFallback={
          detailUrl:page.url(),
          detailPreview:String(text||"").slice(0,600)
        };
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
    noArCache.delete(isbn);
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
    if(event.eventName==="lookup_success" && event.properties?.isbn) rememberRegressionCase(event);
  }catch{
    // Telemetry failure should not surface to the product.
    if(!res.headersSent) res.status(204).end();
  }
});

app.get("/api/admin/analytics",requireAdmin,async(_req,res)=>{
  const events=await readTelemetryEvents();
  res.json({ok:true,events,serverVerification:{running:serverVerificationRunning,latest:serverVerificationLatest,progress:serverVerificationProgress}});
});

app.get("/api/admin/server-recheck-status",requireAdmin,async(_req,res)=>{
  res.json({ok:true,running:serverVerificationRunning,latest:serverVerificationLatest,progress:serverVerificationProgress});
});

app.post("/api/admin/server-recheck",requireAdmin,async(_req,res)=>{
  if(serverVerificationRunning) return res.status(202).json({ok:true,started:false,running:true,latest:serverVerificationLatest,progress:serverVerificationProgress});
  res.status(202).json({ok:true,started:true});
  void runServerVerification({reason:"admin_manual",force:true});
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
.verify-progress-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin:10px 0 12px}.verify-progress-grid>div{background:#f7f8f5;border-radius:10px;padding:10px}.verify-progress-grid b{display:block;font-size:20px}.verify-progress-grid span{font-size:11px;color:#73776f}.status-checking{font-weight:700}.status-completed{color:#35623b}.status-queued{color:#73776f}
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
<span id="refreshStatus" class="muted"></span>
<button id="runServerRecheck">Run server verification</button>
<span id="serverRecheckStatus" class="muted"></span>
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
function filteredAll(){
 const days=Number($("window").value), v=$("version").value;
 const cutoff=Date.now()-days*86400000;
 return raw.filter(e=>dt(e).getTime()>=cutoff && (!v||e.appVersion===v));
}
function isServerEvent(e){
 return e?.installId==="server_verification" || e?.platform==="server" || String(e?.eventName||"").startsWith("server_");
}
function filtered(){
 return filteredAll().filter(e=>!isServerEvent(e));
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
 const lookupCompletion=pct(terminalTechnical.length,lookups.length);
 const arCoverage=pct(ok,terminalTechnical.length);

 // "Accuracy" requires an independent expected answer. At present the trusted
 // audit set is the regression registry (known AR-positive books). A server
 // recheck that merely repeats "No AR" is NOT treated as ground truth.
 const regressionEvents=raw.filter(e=>e.eventName==="server_regression_recheck_completed"&&e.properties?.isbn);
 const trustedTruth=new Map();
 for(const e of regressionEvents){
   const isbn=e.properties.isbn;
   trustedTruth.set(isbn,{expected:"ar",expectedQuizNumber:e.properties?.expectedQuizNumber||null});
 }

 const terminalLookupEvents=ev
   .filter(e=>e.properties?.isbn&&["lookup_success","lookup_no_ar","lookup_error","lookup_timeout"].includes(e.eventName))
   .slice().sort((a,b)=>String(a.timestamp).localeCompare(String(b.timestamp)));

 const auditedAttempts=terminalLookupEvents.filter(e=>trustedTruth.has(e.properties.isbn));
 const correctAuditedAttempts=auditedAttempts.filter(e=>{
   const truth=trustedTruth.get(e.properties.isbn);
   return truth?.expected==="ar" && e.eventName==="lookup_success";
 });
 const verifiedLookupAccuracy=auditedAttempts.length?pct(correctAuditedAttempts.length,auditedAttempts.length):null;

 const capturedISBNs=[...new Set(captureEvents.map(e=>e.properties?.isbn).filter(Boolean))];
 const latestByISBN=new Map();
 for(const e of terminalLookupEvents) latestByISBN.set(e.properties.isbn,e);
 const auditedLibraryISBNs=capturedISBNs.filter(isbn=>trustedTruth.has(isbn));
 const correctAuditedLibraryISBNs=auditedLibraryISBNs.filter(isbn=>{
   const e=latestByISBN.get(isbn);
   const truth=trustedTruth.get(isbn);
   return truth?.expected==="ar" && e?.eventName==="lookup_success";
 });
 const currentLibraryAccuracy=auditedLibraryISBNs.length?pct(correctAuditedLibraryISBNs.length,auditedLibraryISBNs.length):null;
 const verificationCoverage=pct(auditedLibraryISBNs.length,capturedISBNs.length);

 const backup=ev.filter(e=>["backup_success","backup_failed"].includes(e.eventName));
 const backupOK=backup.filter(e=>e.eventName==="backup_success").length;
 const activeDaysByInstall=new Map();
 for(const e of ev){const d=e.timestamp.slice(0,10);if(!activeDaysByInstall.has(e.installId))activeDaysByInstall.set(e.installId,new Set());activeDaysByInstall.get(e.installId).add(d)}
 const returning=[...activeDaysByInstall.values()].filter(s=>s.size>=2).length;

 const metricCard=(label,value,detail="")=>'<div class="card metric"><b>'+value+'</b><span>'+label+'</span>'+(detail?'<div class="muted" style="font-size:11px;margin-top:5px;line-height:1.35">'+detail+'</div>':'')+'</div>';
 $("metrics").innerHTML=[
   metricCard("Active installs",installs),
   metricCard("Sessions",sessions),
   metricCard("Books captured",scans),
   metricCard("Unique books",uniqueBooks),
   metricCard("Lookup completion rate",lookupCompletion+"%",terminalTechnical.length+" of "+lookups.length+" lookup attempts completed without error/timeout"),
   metricCard("Verified lookup accuracy",verifiedLookupAccuracy==null?"—":verifiedLookupAccuracy+"%",correctAuditedAttempts.length+" of "+auditedAttempts.length+" audited lookup attempts returned the independently expected answer"),
   metricCard("Current library accuracy",currentLibraryAccuracy==null?"—":currentLibraryAccuracy+"%",correctAuditedLibraryISBNs.length+" of "+auditedLibraryISBNs.length+" verified library books are currently correct · "+auditedLibraryISBNs.length+" of "+capturedISBNs.length+" books verified"),
   metricCard("Verification coverage",verificationCoverage+"%",auditedLibraryISBNs.length+" of "+capturedISBNs.length+" unique library books have independent ground truth"),
   metricCard("AR coverage",arCoverage+"%","Share of completed lookups that returned an AR record; this is not an accuracy measure"),
   metricCard("Backup success",pct(backupOK,backup.length)+"%"),
   metricCard("Lookup errors",lookups.filter(e=>["lookup_error","lookup_timeout"].includes(e.eventName)).length)
 ].join('');

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
 const auditRows=auditedLibraryISBNs.map(isbn=>{
   const truth=trustedTruth.get(isbn);
   const latest=latestByISBN.get(isbn);
   const current=latest?.eventName==="lookup_success"?"AR found":
     latest?.eventName==="lookup_no_ar"?"No AR":
     latest?.eventName==="lookup_timeout"?"Timeout":
     latest?.eventName==="lookup_error"?"Error":"No terminal result";
   const correct=truth?.expected==="ar"&&latest?.eventName==="lookup_success";
   return {isbn,expected:"AR",current,correct,quiz:truth?.expectedQuizNumber||null};
 });
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
 '<div style="height:14px"></div><b>Accuracy audit</b><div class="muted" style="margin:4px 0 8px">Only books with independent ground truth count toward accuracy. Repeated “No AR” responses are not assumed correct.</div>'+
 (auditRows.length
   ? '<table><tr><th>ISBN</th><th>Expected</th><th>Current result</th><th>Correct?</th></tr>'+
     auditRows.map(r=>'<tr><td class="mono">'+esc(r.isbn)+'</td><td>'+esc(r.expected)+(r.quiz?' · quiz '+esc(r.quiz):'')+'</td><td>'+esc(r.current)+'</td><td class="'+(r.correct?'good':'bad')+'">'+(r.correct?'Yes':'No')+'</td></tr>').join('')+'</table>'
   : '<span class="muted">No captured books currently have independent ground truth.</span>')+
 '<div style="height:12px"></div><b>Successful match paths</b>'+bars(countBy(match,e=>e.properties?.matchBasis||"isbn"))+
 '<div style="height:12px"></div><b>Error types</b>'+bars(countBy(errs,e=>e.properties?.errorCode||e.properties?.errorType||"error"));

 const svProgress=window.__serverVerificationProgress||null;
 const progressBox=svProgress
   ? '<b>'+(svProgress.finishedAt?'Last server verification progress':'Live server verification progress')+'</b>'+
     '<div class="verify-progress-grid">'+
       '<div><b>'+Number(svProgress.queued||0)+'</b><span>Queued</span></div>'+
       '<div><b>'+Number(svProgress.checking||0)+'</b><span>Checking now</span></div>'+
       '<div><b>'+Number(svProgress.completed||0)+'</b><span>Completed</span></div>'+
       '<div><b>'+Number(svProgress.remaining||0)+'</b><span>Remaining</span></div>'+
     '</div>'+
     '<div class="muted">Started '+(svProgress.startedAt?new Date(svProgress.startedAt).toLocaleString():'—')+
       (svProgress.startedAt?' · elapsed '+Math.max(0,Math.round(((svProgress.finishedAt?new Date(svProgress.finishedAt).getTime():Date.now())-new Date(svProgress.startedAt).getTime())/1000))+'s':'')+'</div>'+
     ((svProgress.items||[]).length?'<div style="height:10px"></div><table><tr><th>ISBN</th><th>Type</th><th>Status</th><th>Prior</th><th>Result</th><th>Elapsed</th></tr>'+
       (svProgress.items||[]).slice().sort((a,b)=>{const order={checking:0,queued:1,completed:2};return (order[a.status]??9)-(order[b.status]??9)||String(a.isbn).localeCompare(String(b.isbn))}).map(x=>
         '<tr><td class="mono">'+esc(x.isbn||'')+'</td><td>'+esc(x.historical&&x.regression?'historical + regression':x.historical?'historical':'regression')+'</td><td class="status-'+esc(x.status||'')+'">'+esc(x.status||'')+'</td><td>'+esc((x.priorStatuses||[]).join(', ')||'—')+'</td><td>'+esc(x.resultStatus||x.outcome||'—')+'</td><td>'+esc(x.durationMs!=null?Math.round(Number(x.durationMs)/1000)+'s':(x.startedAt?Math.max(0,Math.round((Date.now()-new Date(x.startedAt).getTime())/1000))+'s':'—'))+'</td></tr>'
       ).join('')+'</table>':'')+
     '<div style="height:18px;border-top:1px solid #eceee9;margin-top:18px;padding-top:16px"></div>'
   : '';

 const serverRuns=raw.filter(e=>e.eventName==="server_verification_finished").slice().sort((a,b)=>String(b.timestamp).localeCompare(String(a.timestamp)));
 const telemetryLatestRun=serverRuns[0]||null;
 const apiLatest=window.__serverVerificationLatest||null;
 const apiLatestFinished=apiLatest?.finishedAt?{
   timestamp:apiLatest.finishedAt, sessionId:apiLatest.runId, appVersion:apiLatest.serverVersion, properties:apiLatest
 }:null;
 const latestServerRun=(apiLatestFinished && (!telemetryLatestRun || String(apiLatestFinished.timestamp)>String(telemetryLatestRun.timestamp)))?apiLatestFinished:telemetryLatestRun;
 const latestRunId=latestServerRun?.sessionId||null;
 const serverHistorical=latestRunId?raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="server_historical_recheck_completed"):[];
 const serverRegression=latestRunId?raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="server_regression_recheck_completed"):[];
 const staleWhileRunning=Boolean(window.__serverVerificationRunning && latestServerRun && svProgress?.runId && latestRunId!==svProgress.runId);
 const serverBox=latestServerRun
   ? '<b>'+(staleWhileRunning?'Previous completed verification':'Immediate server verification')+' · '+esc(latestServerRun.properties?.serverVersion||latestServerRun.appVersion||"")+'</b>'+ 
     '<table><tr><th>Historical unresolved</th><th>Fixed → AR</th><th>Verified no AR</th><th>Still failing</th><th>Regression tests</th><th>Passing</th></tr>'+ 
     '<tr><td>'+Number(latestServerRun.properties?.historicalTotal||0)+'</td><td class="good">'+Number(latestServerRun.properties?.historicalFixedToAr||0)+'</td><td>'+Number((latestServerRun.properties?.historicalConfirmedNoAr||0)+(latestServerRun.properties?.historicalResolvedToNoAr||0))+'</td><td class="'+(latestServerRun.properties?.historicalStillError?'bad':'')+'">'+Number(latestServerRun.properties?.historicalStillError||0)+'</td><td>'+Number(latestServerRun.properties?.regressionTotal||0)+'</td><td class="'+(latestServerRun.properties?.regressionFailed?'bad':'good')+'">'+Number(latestServerRun.properties?.regressionPassed||0)+' / '+Number(latestServerRun.properties?.regressionTotal||0)+'</td></tr></table>'+ 
     (serverHistorical.length?'<div style="height:12px"></div><b>Server historical results</b><table><tr><th>ISBN</th><th>Prior</th><th>Current</th><th>Outcome</th><th>Affected backups</th></tr>'+serverHistorical.slice().sort((a,b)=>String(a.properties?.isbn).localeCompare(String(b.properties?.isbn))).map(e=>'<tr><td class="mono">'+esc(e.properties?.isbn||"")+'</td><td>'+esc((e.properties?.priorStatuses||[]).join(", "))+'</td><td>'+esc(e.properties?.resultStatus||"")+'</td><td>'+esc(e.properties?.outcome||"")+'</td><td>'+Number(e.properties?.affectedBackups||0)+'</td></tr>').join('')+'</table>':'')+
     ((latestRunId?raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="server_verification_diagnostic"):[]).length
       ? '<div style="height:14px"></div><b>Why unresolved books did not match</b><div class="muted" style="margin:5px 0 9px">Server-only trace of metadata and every fallback route attempted. This does not change user libraries.</div>'+
         '<table><tr><th>ISBN / metadata</th><th>Exact ISBN</th><th>Equivalent / Quick</th><th>Title + author</th><th>Related editions</th><th>Final reason</th></tr>'+
         raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="server_verification_diagnostic")
           .slice().sort((a,b)=>String(a.properties?.isbn).localeCompare(String(b.properties?.isbn)))
           .map(e=>{
             const p=e.properties||{};
             const meta='<b class="mono">'+esc(p.isbn||"")+'</b><br>'+esc(p.metadataTitle||"—")+(p.metadataAuthor?'<br><span class="muted">'+esc(p.metadataAuthor)+'</span>':'');
             const eq=[p.equivalentSearchSummary,p.quickSearchSummary].filter(Boolean).map(esc).join('<br>');
             const siblings=(p.siblingCandidates?'<div><b>Candidates:</b> '+esc(p.siblingCandidates)+'</div>':'')+
               (p.siblingSearchSummary?'<details><summary>Attempt details</summary><div class="mono" style="white-space:normal;margin-top:5px">'+esc(p.siblingSearchSummary)+'</div></details>':'');
             const final='<b>'+esc(p.finalStatus||"")+'</b>'+(p.errorCode?'<br>'+esc(p.errorCode):'')+(p.rejectionReason?'<br><span class="muted">'+esc(p.rejectionReason)+'</span>':'')+
               (p.queryTrace?'<details><summary>Full query trace</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word;margin-top:5px">'+esc(p.queryTrace)+'</div></details>':'');
             return '<tr><td>'+meta+'</td><td>'+esc(p.exactSearchSummary||"—")+'</td><td>'+(eq||"—")+'</td><td>'+esc(p.titleAuthorSummary||"—")+'</td><td>'+(siblings||"—")+'</td><td>'+final+'</td></tr>';
           }).join('')+'</table>'
       : '')+
     ((latestRunId?raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="bookfinder_exact_probe"):[]).length
       ? '<div style="height:14px"></div><b>Known alternate ISBN probes</b><div class="muted" style="margin:5px 0 9px">Direct Bookfinder probes for two known older editions plus a known-good control. Diagnostic only.</div>'+
         '<table><tr><th>ISBN</th><th>Result structure</th><th>Book links</th><th>Returned text / HTML</th></tr>'+
         raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="bookfinder_exact_probe")
           .map(e=>{const p=e.properties||{};
             const structure='<b>'+esc(p.probeLabel||"")+'</b><br>role='+esc(p.role||"—")+' · results='+esc(p.resultCount??"—")+' · quiz='+esc(p.containsQuiz?"yes":"no")+' · ATOS='+esc(p.containsATOS?"yes":"no")+' · detail links='+esc(p.uniqueDetailLinks??"—")+
               (p.probeError?'<br><span class="bad">'+esc(p.probeError)+'</span>':'')+
               '<br><span class="mono">'+esc(p.finalUrl||"")+'</span>';
             const snippets='<details><summary>Body text</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word">'+esc(p.probeBodyText||"")+'</div></details>'+
               '<details><summary>HTML near ISBN / AR fields</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word">'+esc(p.probeHtmlSnippet||"")+'</div></details>';
             return '<tr><td class="mono">'+esc(p.probeISBN||"")+'</td><td>'+structure+'</td><td class="mono">'+esc(p.probeBookLinks||"—")+'</td><td>'+snippets+'</td></tr>';
           }).join('')+'</table>'
       : '')+
     ((latestRunId?raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="metadata_source_probe"):[]).length
       ? '<div style="height:14px"></div><b>Hardy Boys metadata source probes</b><div class="muted" style="margin:5px 0 9px">Raw bibliographic responses for the newer reprint ISBNs. Diagnostic only.</div>'+
         '<table><tr><th>ISBN</th><th>Open Library direct</th><th>Open Library search</th><th>Google Books exact ISBN</th></tr>'+
         raw.filter(e=>e.sessionId===latestRunId&&e.eventName==="metadata_source_probe")
           .map(e=>{const p=e.properties||{};return '<tr><td class="mono">'+esc(p.isbn||"")+'</td>'+
             '<td><details><summary>View</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word">'+esc(p.openLibraryDirect||"")+'</div></details></td>'+
             '<td><details><summary>View</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word">'+esc(p.openLibrarySearch||"")+'</div></details></td>'+
             '<td><details><summary>View</summary><div class="mono" style="white-space:pre-wrap;word-break:break-word">'+esc(p.googleBooksExact||"")+'</div></details></td></tr>'}).join('')+
         '</table>'
       : '')+
     (serverRegression.some(e=>!e.properties?.passed)?'<div style="height:12px"></div><b class="bad">Regression failures</b><table><tr><th>ISBN</th><th>Result</th><th>Error</th></tr>'+serverRegression.filter(e=>!e.properties?.passed).map(e=>'<tr><td class="mono">'+esc(e.properties?.isbn||"")+'</td><td>'+esc(e.properties?.resultStatus||"")+'</td><td>'+esc(e.properties?.errorCode||"")+'</td></tr>').join('')+'</table>':'')
   : '<b>Immediate server verification</b><div class="muted" style="margin-top:6px">No server verification run has completed yet. It runs automatically once per server release; you can also run it manually above.</div>';

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
 $("fixVerification").innerHTML=progressBox+serverBox+'<div style="height:18px;border-top:1px solid #eceee9;margin-top:18px;padding-top:16px"><b>Client repair after user returns</b></div>'+fixSummary+fixDetails;

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
async function load({manual=false}={}){
 const btn=$("refresh");
 const priorVersion=$("version").value;
 if(manual){
   btn.disabled=true;btn.textContent='Refreshing…';
   $("refreshStatus").textContent='Loading latest analytics…';
 }
 try{
   const r=await fetch("/api/admin/analytics",{cache:"no-store"});
   if(!r.ok)throw new Error('Could not load analytics');
   const j=await r.json();raw=j.events||[];
   const userEvents=raw.filter(e=>!isServerEvent(e));
   const versions=[...new Set(userEvents.map(e=>e.appVersion).filter(Boolean))].sort().reverse();
   $("version").innerHTML='<option value="">All versions</option>'+versions.map(v=>'<option>'+esc(v)+'</option>').join('');
   if(versions.includes(priorVersion))$("version").value=priorVersion;
   const sv=j.serverVerification||{};
   window.__serverVerificationProgress=sv.progress||null;
   window.__serverVerificationLatest=sv.latest||null;
   window.__serverVerificationRunning=Boolean(sv.running);
   $("serverRecheckStatus").textContent=sv.running?'Server verification running…':(sv.latest?.finishedAt?'Last completed '+new Date(sv.latest.finishedAt).toLocaleString():'');
   render();
   if(manual){
     btn.textContent='Updated ✓';
     $("refreshStatus").textContent='Last updated '+new Date().toLocaleTimeString();
     setTimeout(()=>{btn.textContent='Refresh';btn.disabled=false},1400);
   }
   if(sv.running){clearTimeout(window.__verificationPoll);window.__verificationPoll=setTimeout(()=>load(),1500)}
 }catch(e){
   if(manual){btn.textContent='Refresh failed';$("refreshStatus").textContent='Could not update';setTimeout(()=>{btn.textContent='Refresh';btn.disabled=false},1800)}
   else $("metrics").innerHTML='<div class="card">Could not load analytics.</div>';
 }
}
async function manualRefresh(){return load({manual:true})}
async function runServerRecheck(){
 const btn=$("runServerRecheck");btn.disabled=true;$("serverRecheckStatus").textContent='Starting server verification…';
 try{
   const r=await fetch("/api/admin/server-recheck",{method:"POST"});
   if(!r.ok)throw new Error('Could not start');
   $("serverRecheckStatus").textContent='Server verification running…';
   setTimeout(load,3000);
 }catch{$("serverRecheckStatus").textContent='Could not start server verification.'}
 finally{setTimeout(()=>btn.disabled=false,2500)}
}
$("window").onchange=render;$("version").onchange=render;$("refresh").onclick=manualRefresh;$("runServerRecheck").onclick=runServerRecheck;load();
</script></body></html>`;
}

app.get("/admin",requireAdmin,(_req,res)=>res.type("html").send(analyticsAdminHtml()));

app.get("/health",(_req,res)=>res.status(200).json({ok:true,service:"scan-ar",version:SERVER_VERSION,time:new Date().toISOString()}));
app.get("/api/lookup-status",(_req,res)=>res.json({
  ok:true,
  version:SERVER_VERSION,
  bookfinderUrl:BOOKFINDER_URL,
  browserInitialized:Boolean(browserPromise),
  cacheEntries:cache.size
}));

app.get("/api/status",async(_req,res)=>{
  try{const b=await getBrowser();res.json({ok:true,browserConnected:b.isConnected(),browserCrashes,cacheEntries:cache.size})}
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
// v6.4.3: after this point no NEW candidate-edition query is started, so a slow
// lookup can report where its time went instead of dying with a bare LOOKUP_TIMEOUT.
const CANDIDATE_START_CUTOFF_MS=36000;
// v6.4.4: a parent's live scan always outranks background verification. The analytics
// showed a verification run and manual lookups competing for one browser, and the
// live lookups timed out.
let activeUserLookups=0;
async function waitForUserLookupsToFinish(maxWaitMs=180000){
  const until=Date.now()+maxWaitMs;
  while(activeUserLookups>0 && Date.now()<until){
    await new Promise(r=>setTimeout(r,500));
  }
}

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
    activeUserLookups++;
    const result=await withLookupDeadline(performLookup(isbn,{refresh:req.query.refresh==="1"}))
      .finally(()=>{activeUserLookups=Math.max(0,activeUserLookups-1)});
    return res.json(result);
  }catch(e){
    console.error(`[lookup ${isbn}]`,e);
    if(e.code==="LOOKUP_TIMEOUT"){
      const t=liveTiming.get(isbn);
      return res.status(504).json({
        isbn,
        error:"AR lookup took too long. Please retry.",
        code:"LOOKUP_TIMEOUT",
        timing:t?{totalMs:t.elapsed(),steps:t.steps}:null,
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
      browserCrash:isBrowserCrash(e)||undefined,
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
const server=app.listen(port,"0.0.0.0",()=>{
  console.log(`My AR Shelf v${SERVER_VERSION} listening on ${port}`);
  // Verify historical unresolved books and known-good regressions once per release.
  setTimeout(()=>{void runServerVerification({reason:"startup_release",force:false})},60000);
});
async function shutdown(){
  console.log("Shutting down…");server.close();
  if(browserPromise){try{(await browserPromise).close()}catch{}}
  process.exit(0);
}
process.on("SIGTERM",shutdown);process.on("SIGINT",shutdown);
