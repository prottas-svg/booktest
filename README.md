# SnapAR v2.7

**Build date:** September 15, 2026

## UI polish release
This release modernizes the interface without changing the storage or lookup model.

# SnapAR v2.2

**Build date:** September 15, 2026

## Library protection
This release separates app versions from user data and adds automatic online backups.

### Storage layers
1. **On-device app data** — uses one permanent storage namespace across releases.
2. **Railway server backup** — books, kids, AR ranges, range histories, and per-child statuses are backed up automatically under a private recovery code.
3. **Phone files** — CSV session backups and full JSON exports remain available.

### Important Railway setup
For online backups to survive Railway redeployments, add a **persistent Railway Volume** to this service and mount it at:

`/data`

The app writes server backups to `/data/backups`.

Without a persistent volume, the app still keeps on-device data and downloadable CSV/JSON backups, but online server backups may be lost when Railway replaces the container.

### Recovery
Settings displays a private recovery code such as `ABCD-EFGH-JKLM-NPQR`. On a new device, choose **Restore with code** and enter that code to recover the full library.

# SnapAR v2.1

**Build date:** September 15, 2026

## Installable web app
- Adds a web app manifest and SnapAR Home Screen icons.
- When added to an iPhone Home Screen, SnapAR opens in standalone app mode.
- A one-time message explains: Safari → Share → Add to Home Screen.
- Service worker caches the app shell; AR lookups still require an internet connection.

# SnapAR v2.0

**Build date:** September 15, 2026

## v2.0 backup protection
- Auto-backup is on by default.
- After a scan session with one or more captured books, turning the camera off or leaving Scan attempts to download a timestamped CSV to the device.
- CSV contains the household library, lookup/AR fields, scan timestamps, and per-child current range/status columns.
- Settings includes **Download CSV now**.
- Full JSON export remains available because it is the safest format for restoring child profiles, range histories, and complete app state.
- The app shows the last successful backup time.

### Mobile-browser caveat
iOS/browser download behavior can vary. Auto-backup is attached to explicit user actions (turning the camera off or tapping another tab) to maximize the chance Safari permits the file download. Use the visible manual CSV button if a browser suppresses an automatic download.

# SnapAR v1.9

**Build date:** September 15, 2026

## v1.9 visual cleanup
This release intentionally adds no new functionality. It simplifies the interface into a calmer, minimalist utility: warm off-white background, muted green accent, fewer cards, less explanatory copy, more whitespace, cleaner typography, and more restrained library/kid status styling.

# SnapAR v1.8

**Build date:** September 15, 2026

## v1.8 change
After the very first book is captured, the Scan page shows a one-time prompt:
**Keep scanning** or **View Library**. It explains that AR lookups continue in the background, so users do not need to wait between books. Once either option is chosen, the prompt does not appear again.

# SnapAR v1.7

**Build date:** September 15, 2026

## Focus of v1.7

- Camera is off by default and only runs on the Scan page.
- Rapid scanning never waits for AR lookups.
- Duplicate scans clearly say **Already in library**.
- Exact ISBN AR match only; no fuzzy title/edition substitution.
- Separate states for:
  - AR match found
  - No AR quiz found for this ISBN
  - Technical lookup error
  - Pending lookup
- Books without AR data still try to show title and author from Open Library.
- Household library is separate from child-specific status.
- Each child has an editable AR range with range history.
- Child filters: In range, Below, Above, Read, Not interested, All AR books.
- Child actions are reversible and never delete the household book.
- AR source and last-checked date are displayed.

## Deploy

Upload the contents of this `scan-ar-proxy` folder to the root of your GitHub repository. Railway should redeploy automatically.

## Accuracy model

AR data is accepted only when:
1. a valid ISBN checksum was scanned/entered,
2. AR Bookfinder returns AR fields, and
3. the exact scanned ISBN can be verified on the returned result/detail page.

A 404 from the app means **No AR quiz found for this ISBN**, not that every edition of that title lacks an AR quiz. Technical/parser problems return a distinct lookup error.
