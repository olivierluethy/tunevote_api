# cPanel — How to Create a Domain / Subdomain (e.g. `app.tunevote.com`)

A step-by-step guide documenting exactly how `app.tunevote.com` was created on the GoDaddy
cPanel account, plus the web-UI equivalent and the DNS/SSL follow-up needed to make it live.

---

## 0. Access details

| Item | Value |
|------|-------|
| Server IP | `132.148.178.39` |
| cPanel user | `gr41l1kzrrhf` |
| cPanel password | *(from your password manager — never commit it to a file/repo)* |
| cPanel web UI | `https://132.148.178.39:2083` |
| Main domain | `r1t.67c.mytemp.website` |

---

## Background — why this was added as an *addon domain*

`app.tunevote.com` is a subdomain of `tunevote.com`. Normally you'd create it as a
**subdomain** under `tunevote.com` — **but `tunevote.com` is not hosted on this account**
(it was removed earlier). cPanel can only create a subdomain under a domain it already
manages.

So instead it was added as an **addon domain**: cPanel accepts any fully-qualified name as
an addon domain, creates an Apache vhost for it, and points it at a document root. This is
the correct way to host `app.tunevote.com` here without first re-adding `tunevote.com`.

> If `tunevote.com` *were* hosted on this account, the cleaner path would be:
> **Domains → Create → subdomain `app` under `tunevote.com`** (or `SubDomain::addsubdomain`
> via the API).

---

## Method A — cPanel Web UI (simplest)

1. Log in at **`https://132.148.178.39:2083`**.
2. Open **Domains** (or **Domains → Addon Domains** on older themes).
3. Click **Create A Domain** / **Add Domain**.
4. **New Domain Name:** `app.tunevote.com`
5. **Document Root:** `public_html/app.tunevote.com` (cPanel auto-fills this).
   - Leave *"Share document root"* unchecked if you want its own folder.
6. Click **Submit / Add Domain**.
7. Upload the site files into `public_html/app.tunevote.com` (via File Manager or FTP), or
   deploy your build there.

That's the exact equivalent of what the API call below did.

---

## Method B — cPanel API over HTTPS (what was actually used)

> Reminder: the SSH shell is CageFS-jailed, so the `cpapi2` **command line** is broken and
> UAPI's CLI lacks these functions. The API only works over **HTTPS on port `2083`**, which
> runs in the full cPanel context. All calls use HTTP Basic Auth.

Supply the password via an environment variable so it never lands in shell history:

```bash
read -s -p "cPanel password: " PASS && export PASS
USER=gr41l1kzrrhf
HOST=132.148.178.39
```

### B.1 (Optional) Confirm the current domains first

```bash
curl -sk -u "$USER:$PASS" "https://$HOST:2083/execute/DomainInfo/list_domains"
```

### B.2 Create the domain

```bash
curl -sk -u "$USER:$PASS" -G \
  --data-urlencode "cpanel_jsonapi_apiversion=2" \
  --data-urlencode "cpanel_jsonapi_module=AddonDomain" \
  --data-urlencode "cpanel_jsonapi_func=addaddondomain" \
  --data-urlencode "newdomain=app.tunevote.com" \
  --data-urlencode "dir=public_html/app.tunevote.com" \
  --data-urlencode "subdomain=app" \
  "https://$HOST:2083/json-api/cpanel"
```

**Parameters**

| Param | Meaning | Value used |
|-------|---------|------------|
| `newdomain` | The domain to create | `app.tunevote.com` |
| `dir` | Document root (relative to home) | `public_html/app.tunevote.com` |
| `subdomain` | Internal subdomain label cPanel builds under the main domain | `app` |

**Successful response** contained:

```
result = 1
reason = The system successfully parked (aliased) the domain
         "app.tunevote.com" on top of the domain "app.r1t.67c.mytemp.website".
```

### B.3 Verify

```bash
# Domain now appears under addon_domains:
curl -sk -u "$USER:$PASS" "https://$HOST:2083/execute/DomainInfo/list_domains"

# Document root exists (over SSH):
ssh $USER@$HOST 'ls -lah ~/public_html/app.tunevote.com'
```

In this case the document root **already contained a built Vite PWA** frontend
(`index.html`, `assets/`, `sw.js`, `manifest.webmanifest`, `workbox-*.js`), so the domain
immediately points at a real app.

```bash
unset PASS   # clear the password from the environment when done
```

---

## Making it live — DNS (required) and SSL

Creating the addon domain set up the **web server** side on this host. Two more things are
needed for it to work publicly:

### 1. DNS — point the name at this server
Because `tunevote.com`'s DNS zone is **not** on this account, you must add a record wherever
`tunevote.com`'s DNS is managed (the registrar or DNS provider for `tunevote.com`):

```
app.tunevote.com.   A   132.148.178.39
```

(or a `CNAME` to the server hostname). Until this record exists and propagates,
`app.tunevote.com` will resolve nowhere even though the server is ready to serve it.

Check propagation:

```bash
dig +short app.tunevote.com     # should return 132.148.178.39
```

### 2. SSL — HTTPS certificate
Once DNS resolves to this server, cPanel's **AutoSSL** should issue a certificate on its
next run. To do it immediately: cPanel → **SSL/TLS Status** → select `app.tunevote.com` →
**Run AutoSSL**.

---

## Quick reference — create vs. remove

| Action | API module / function |
|--------|-----------------------|
| Create domain | `AddonDomain::addaddondomain` (`newdomain`, `dir`, `subdomain`) |
| Create subdomain (parent exists) | `SubDomain::addsubdomain` (`domain`, `rootdomain`, `dir`) |
| Remove subdomain | `SubDomain::delsubdomain` (`domain`) |
| Remove addon domain | `AddonDomain::deladdondomain` (`domain`, `subdomain=<sub>_<rootdomain>`) |
| List all domains | `DomainInfo::list_domains` (UAPI, read-only) |

---

## Security note

Never hard-code the cPanel password in scripts, files, or git. Use the `read -s` prompt
shown above, and rotate the password if it has ever been shared in plain text.
