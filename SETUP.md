# Fleet Driver App – setup guide (proof of concept)

What's in this folder:

| Folder / file | What it is |
|---|---|
| `app/` | The driver app. These files go on the free website host (Part B). |
| `app/config.js` | The only file you normally edit: the server link and the photo-check settings. |
| `server/Code.gs` | The server. It runs inside a Google Sheet (Part A). |

How it fits together: drivers open the app on their phone. Photos go to the control room's **Google Drive**, into one folder per POD number (`Fleet App Uploads/<POD number>/`). Every photo and every completed load is logged in the **Google Sheet**. No payment card is needed.

---

## Try it first in demo mode (5 minutes, optional)

Leave `apiUrl: ''` in `config.js` and do Part B only. The app then works with **any username and PIN 123456**. Nothing is sent anywhere, so you can test the camera and photo check on your own phone before the server is ready.

---

## Part A – The server (Google Sheet), about 15 minutes

1. Sign in to Google with the **control room's Google account** (not a personal one).
2. Create a new Google Sheet called **Fleet App Data**.
3. In the Sheet: **Extensions → Apps Script**. Delete what is there, paste everything from `server/Code.gs` and click **Save**. Name the project **Fleet App server**.
4. Go back to the Sheet and reload the page. A **Fleet App** menu appears. Click **Fleet App → Set up (run once)**.
   - Google asks for permission to use Sheets and Drive. Click **Continue / Allow**.
   - If it says *"Google hasn't verified this app"*: click **Advanced → Go to Fleet App server**. It is your own script, so this is safe.
5. Open the **Drivers** tab. Before typing PINs, select column D (`new_pin`) and set **Format → Number → Plain text**, so PINs starting with 0 are kept.
6. Add yourself as the first test driver:

   | username | name | fleet_no | new_pin | active |
   |---|---|---|---|---|
   | angus | Angus Black | T344 | 6 digits | TRUE |

   Then click **Fleet App → Save new PINs**. The PIN is stored scrambled (hashed) and the PIN cell is cleared. Write new PINs down for the drivers before you click this.
7. In Apps Script: **Deploy → New deployment**. Click the gear icon, choose **Web app**, and set:
   - **Execute as:** Me
   - **Who has access:** Anyone

   Click **Deploy**, then copy the **Web app URL** (it ends in `/exec`).
8. Paste that URL into `app/config.js`:
   ```js
   apiUrl: 'https://script.google.com/macros/s/....../exec',
   ```

**Later changes to Code.gs:** use **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. The URL stays the same.

**Blocking a driver:** set their `active` cell to FALSE. Their phone is signed out the next time it sends something.
**New PIN for a driver:** type a new PIN in `new_pin`, then **Fleet App → Save new PINs**.

---

## Part B – The app's website (GitHub Pages, free), about 15 minutes

1. Create a free account on **github.com** with a work email. Choose a neutral username, for example `fleetcomms`. It becomes part of the app's link.
2. Click **+ → New repository**, name it **fleet-driver**, set it to **Public** and click **Create**.
   - The app files contain no passwords or driver data. Everything private stays in the Google Sheet and Drive.
3. Click **uploading an existing file**. Drag in **everything inside the `app` folder** (not the folder itself), including the `icons` folder, then click **Commit changes**.
4. Go to **Settings → Pages**. Under *Branch*, choose **main** and **/ (root)**, then click **Save**.
5. After about a minute the app is live at: `https://<your-username>.github.io/fleet-driver/`

**Updating the app later:** upload the changed files the same way. Before uploading, change the version line at the top of `sw.js`, for example `fleet-driver-v1` → `fleet-driver-v2`, so phones fetch the new version.

---

## Part C – Install on a phone

1. Open the link in **Chrome** on the phone.
2. Sign in with the username and PIN from the Drivers tab.
3. Tap **⋮ → Add to Home screen** (or **Install app**).
4. Allow **camera** and **location** when asked.

---

## Running the pilot (suggested: 3–5 Imperial drivers for 2 weeks)

Check these each week:
- **Uploads tab → `sharpness` column:** compare the numbers with the photos. If blurry photos get through, raise `minSharpness` in `config.js`. If good photos are rejected, lower it. The starting value of 120 was set on test images, not real driver photos.
- **`flagged_by_driver` = YES:** photos the driver sent anyway after 2 failed checks. A camera problem or a hard document?
- **Submissions tab:** time from loading or offloading to `received_at`, and the `work_data_mb_this_month` per driver.
- **Drive folders:** does each POD folder have all 6 photos (3 at loading, 3 at offloading)?

## Limits of this proof of concept

- **Photo storage:** photos use the Google account's Drive space. A free account has 15 GB, roughly 30,000 photos at the app's size.
- **Server:** Google Apps Script handles one upload at a time. That is fine for a pilot, but not for the whole fleet sending at once. The full version would move to a proper server.
- **Live location:** the app only takes a GPS position when a load is captured. Live breakdown location needs the full Android app.
- **Data counter:** it counts only this app's data, not WhatsApp. Work WhatsApp data will come from the validator.
- **Privacy (POPIA):** share the Sheet and the Drive folder only with authorised staff.
