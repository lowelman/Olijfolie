# Olijfolie bestellen

A one-page preorder form for olive oil. Orders are saved as rows in a Google Sheet, which you can share with anyone.

- `index.html` is the page itself and is hosted on GitHub Pages.
- `apps-script/Code.gs` is the backend. It runs inside your Google Sheet and adds each order as a row.

Everything is free. You only need a Google account and a GitHub account.

## 1. Create the Google Sheet

1. Go to [sheets.new](https://sheets.new) to create a new spreadsheet.
2. Give it a name, for example *Olijfolie bestellingen*.

You don't need to add columns yourself. The script creates a sheet called **Bestellingen** with the headers `Tijdstip | Naam | E-mail | Aantal flessen` on the first confirmed order.

It also creates a hidden sheet called **Onbevestigd**. Orders wait there until the customer clicks the link in the confirmation email (see step 6). Unconfirmed orders are removed automatically after 48 hours.

## 2. Add the script

1. In the spreadsheet, open **Extensions → Apps Script**.
2. Delete the sample code and paste in the full contents of [apps-script/Code.gs](apps-script/Code.gs).
3. Click the **gear icon (Project Settings)** and tick **Show "appsscript.json" manifest file in editor**.
4. Go back to the **Editor** (`<>` icon), open `appsscript.json`, and replace its contents with [apps-script/appsscript.json](apps-script/appsscript.json). This limits the script to *this one spreadsheet* instead of all your spreadsheets.
5. Click the **Save** icon.

## 3. Deploy it as a web app

1. Click **Deploy → New deployment**.
2. Click the gear icon next to *Select type* and choose **Web app**.
3. Set **Execute as** to **Me**.
4. Set **Who has access** to **Anyone**. This lets the public page send orders to it.
5. Click **Deploy**, then **Authorize access**, and pick your Google account. The permission screen should say *"View and manage spreadsheets that this application has been installed in"*, **not** *"…all your Google Sheets spreadsheets"*.
   - Google will warn that the app isn't verified. Click **Advanced → Go to … (unsafe)**. This is safe because it's your own script.
6. Copy the **Web app URL**. It ends in `/exec`.

To check that it works, open that URL in your browser. You should see `{"ok":true,"status":"Bestelformulier actief"}`.

## 4. Connect the page

In `index.html`, replace the placeholder with your URL:

```js
const SCRIPT_URL = "https://script.google.com/macros/s/…/exec";
```

## 5. Set up the captcha (Cloudflare Turnstile)

The captcha stops bots from flooding the spreadsheet with fake orders. Most visitors never see a puzzle; it usually passes automatically.

**a. Create the widget in Cloudflare**
1. Log in at [dash.cloudflare.com](https://dash.cloudflare.com).
2. Click **Turnstile** in the left menu. If you can't find it, type "Turnstile" in the search bar at the top.
3. Click **Add widget**.
4. Fill in:
   - **Widget name:** e.g. `Olijfolie bestellen`
   - **Hostnames:** add `<your-github-username>.github.io` and also `localhost` (for testing on your own computer)
   - **Widget Mode:** **Managed**
   - **Pre-clearance:** **No**
5. Click **Create**. You now see two keys:
   - **Site Key**: public, goes in `index.html`
   - **Secret Key**: private, goes in Apps Script. **Never put this in `index.html` or on GitHub.**

**b. Put the site key in the page**

In `index.html`, replace the placeholder:
```js
const TURNSTILE_SITE_KEY = "0x4AAAAAAA...";
```

**c. Put the secret key in Apps Script**
1. In the spreadsheet, open **Extensions → Apps Script**.
2. Click the **gear icon (Project Settings)** in the left sidebar.
3. Scroll down to **Script Properties** and click **Add script property**.
4. **Property:** `TURNSTILE_SECRET`. **Value:** paste your Secret Key.
5. Click **Save script properties**.

Until this property is set, every order is refused.

**d. Redeploy the script**

The script now contacts Cloudflare, so Google needs new permission. Go to **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. When asked, approve the permissions again.

## 6. Set up email confirmation

Every order must be confirmed by email, so nobody can order in someone else's name:

1. The customer fills in the form.
2. They get an email with a link to the order page.
3. On that page they click **Bestelling bevestigen**.
4. Only then does the order appear in **Bestellingen**.

The email is sent from **your own Gmail address**, with the sender name *Olijfolie*. Customers can see your address and reply to it.

**a. Tell the script where the page lives**

The link in the email points to your page, so the script needs its address:
1. At the top of `Code.gs`, under **LINKS — fill these in**, set `SITE_URL` to the address of your page, e.g. `https://<your-username>.github.io/<repo>/`.
   - To test locally, temporarily use the `localhost` address from `npx serve .` instead, e.g. `http://localhost:3000/`.
2. Paste the updated code into the Apps Script editor and save.

Until `SITE_URL` is filled in, every order is refused.

**b. Redeploy the script**

Sending email needs a new permission. Go to **Deploy → Manage deployments → pencil icon → Version: New version → Deploy**. When asked, approve the permissions again. The permission screen should now also mention *"Send email as you"*.

**Limits:** a free Gmail account can send about 100 emails per day. When that runs out, the page tells visitors to try again tomorrow. Each email address can place at most 3 orders per 6 hours.

## 7. Publish on GitHub Pages

1. Create a new **public** repository on GitHub. GitHub Pages is free for public repos.
2. Push this folder to it:
   ```sh
   git init
   git add .
   git commit -m "Olive oil preorder page"
   git branch -M main
   git remote add origin https://github.com/<your-username>/<repo>.git
   git push -u origin main
   ```
3. In the repo, go to **Settings → Pages**. Under *Source*, choose **Deploy from a branch**, then select `main` and `/ (root)`. Click **Save**.
4. After a minute the page is live at `https://<your-username>.github.io/<repo>/`.

The orders themselves are never stored in the repo. They only live in your Google Sheet.

## 8. Share the orders

In the spreadsheet, click **Share** and add people:

- **Viewer** if they should only see the orders.
- **Editor** if they may change them, for example to mark orders as paid or delivered.

You can safely add your own columns after `Aantal flessen`. Don't rename, move or edit the hidden **Onbevestigd** sheet.

## Making changes

- **Page:** edit `index.html`, then commit and push. GitHub Pages updates automatically.
- **Script:** after editing the code in the Apps Script editor, go to **Deploy → Manage deployments**, click the pencil icon, set *Version* to **New version**, and click **Deploy**. This keeps the same URL. Don't use *New deployment*, because that creates a new URL.
- To preview the page locally, run `npx serve .` and open the `localhost` address it shows. Double-clicking `index.html` doesn't work, because the captcha only works on a real web address.
