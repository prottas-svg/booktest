My AR Shelf v5.4 — Fix Verification Patch

This package contains the exact manual edits for the current prottas-svg/booktest v5.3 code.

Files affected:
1. public/index.html
2. server.js
3. public/service-worker.js

What this patch does:
- bumps the app/recheck release to 5.4
- preserves the prior status/version when unresolved books are auto-rechecked
- records whether historical failures become:
  * fixed_to_ar
  * confirmed_no_ar
  * resolved_to_no_ar
  * still_error
- adds release/version provenance to lookup telemetry
- makes manual retries attributable
- adds a Fix verification section to /admin
- fixes the timeout dashboard count so server LOOKUP_TIMEOUT errors count as timeouts
- keeps confirmed AR books protected from downgrade
- does NOT change AR matching/lookup logic

Recommended manual workflow:
A. In GitHub, edit public/index.html and apply the replacements in public-index-replacements.txt
B. Edit server.js and apply server-replacements.txt
C. Edit public/service-worker.js and apply service-worker-replacements.txt
D. Commit all 3 changes together with message:
   Add v5.4 fix-verification analytics
E. Railway should redeploy from main.

There is also apply_v5_4.py if you prefer to download the repo locally and have the script make the same edits automatically.
