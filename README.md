# Scan AR v1.4

**Build date:** September 15, 2026

## v1.4 UX changes
- Clearer scan target with instruction to move closer.
- More square-friendly scan guide on phones.
- Large checkmark + haptic feedback when a barcode is captured.
- Visible scan queue summary.
- Child actions are explicit and reversible; no swipe deletes from the household library.
- Version/date remain visible on the main screen.

# Scan AR v1.3

**Build date:** September 15, 2026

# Scan AR v1.2 — personal prototype

## What changed

- Rapid continuous barcode scanning: scanning never waits for AR lookup.
- Background lookup queue with two concurrent lookups.
- Persistent household library and scan history in the browser.
- Failed/no-AR scans are retained but hidden by default; they can be filtered and retried.
- Unlimited child profiles.
- Editable current AR range for each child, with prior ranges retained in profile history.
- Per-child book state: Available, Read, Hidden.
- A book marked Read/Hidden for one child remains in the household library and can still be available to another child.
- Child-filtered library shows only currently appropriate Available books and totals their AR points.
- Swipe left on a child's book = Read. Swipe right = Hidden. Buttons are also provided.
- Local JSON backup export.

## Deploy/update on Railway

Replace the files in your existing GitHub repository with the contents of this folder and commit/push. Railway should automatically redeploy the service from GitHub.

After deployment, open the existing Railway URL. Your previous local browser data from the older app is not migrated automatically because v1.2 uses a new data model.

## Data model

Book records are household-level. Child profiles only store current reading range and child-specific states, so changing a child's range later never deletes or duplicates books.

## Important

This is the personal-use prototype using the AR Bookfinder lookup automation. Before public App Store distribution, replace that lookup source with a licensed feed.
