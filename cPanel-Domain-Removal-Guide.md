# cPanel — How to Permanently Remove Domains & Subdomains

A step-by-step guide for removing domains from the GoDaddy cPanel hosting account so
that they are **gone for good** — not just their files.

> **Key concept — why deleting folders isn't enough**
> Deleting a site's folder in `public_html` (via File Manager or FTP) only removes the
> **files**. The **domain registration inside cPanel stays**, and cPanel/Apache will
> automatically **re-create the empty document-root folder**. To make a domain truly
> disappear you must delete the **domain/subdomain entry itself**, which also removes its
> Apache vhost and DNS zone. After that, its folder can be deleted and will not come back.

---

## 0. Access details

| Item | Value |
|------|-------|
| Server IP | `132.148.178.39` |
| Hosting | GoDaddy cPanel (shared) — server `p3plzcpnl506305.prod.phx3.secureserver.net` |
| cPanel user | `gr41l1kzrrhf` |
| cPanel password | *(stored in your password manager — never commit it to a file/repo)* |
| cPanel web UI | `https://132.148.178.39:2083` (or via the GoDaddy account → **My Products → cPanel Admin**) |
| SSH | `ssh gr41l1kzrrhf@132.148.178.39` (port 22) |
| Main domain (do **not** delete) | `r1t.67c.mytemp.website` |

---

## Method A — cPanel Web UI (recommended, simplest)

This is the safest and most visible way. Use it unless you specifically need automation.

### A.1 Log in
1. Go to **`https://132.148.178.39:2083`** (accept the certificate warning — it's the
   shared-host cert), or open cPanel from your GoDaddy dashboard.
2. Sign in with the cPanel **username** and **password**.

### A.2 Remove **subdomains** first
Subdomains that live *under* a domain you're deleting (e.g. `api.example.com` under
`example.com`) should be removed before the parent domain.

1. On the cPanel home screen, open **Domains → Subdomains** (older themes) **or**
   **Domains** (newer "unified" theme).
2. Find the subdomain in the list.
3. Click **Remove / Delete** next to it and confirm.

### A.3 Remove **addon domains**
1. Open **Domains → Addon Domains** (older themes) **or** **Domains** (newer theme).
2. Find the domain (e.g. `tunevote.com`).
3. Click **Remove**. When prompted, choose to also remove the DNS entry if asked.
4. Confirm.

> On the **newer "Domains" interface**, addon domains and subdomains appear in one list;
> just click **Manage → Remove Domain** for each entry.

### A.4 Delete the leftover folder (optional cleanup)
Once the domain no longer exists it will **not** regenerate its folder. Delete the empty
document root in **File Manager** under `public_html/<domain>` if you want a tidy account.

### A.5 Verify
Return to **Domains** — the removed entries should be gone. Done.

---

## Method B — cPanel API over HTTPS (for scripting / automation)

Use this when you want to remove many domains at once, or script the process.

> **Important limitation we discovered:** on this account the **SSH shell is CageFS-jailed**.
> The `cpapi2` command-line tool is **broken there** (it can't find the cPanel binary), and
> UAPI's command-line modules do **not** expose domain deletion. **The API only works over
> HTTPS on port `2083`**, which runs in the full cPanel context. That is the method below.

All calls use HTTP Basic Auth with the cPanel username and password.
Replace `USER` and `PASS` with real credentials (supply the password via an environment
variable so it never lands in shell history — see the note at the end).

### B.1 List all domains (read-only, always do this first)

```bash
curl -sk -u "USER:PASS" \
  "https://132.148.178.39:2083/execute/DomainInfo/list_domains"
```

Returns JSON with `main_domain`, `addon_domains`, `sub_domains`, `parked_domains`.
**Never delete `main_domain`.**

### B.2 Get the exact internal keys needed for addon deletion

Addon-domain deletion needs the domain's internal **subdomain key**, not just its name.
List them:

```bash
curl -sk -u "USER:PASS" \
  "https://132.148.178.39:2083/json-api/cpanel?cpanel_jsonapi_apiversion=2&cpanel_jsonapi_module=AddonDomain&cpanel_jsonapi_func=listaddondomains"
```

For each addon you'll see `domain`, `subdomain`, and `rootdomain`. The delete call needs:

```
subdomain_key = <subdomain> + "_" + <rootdomain>
```

Example: for `grammar-mentor.com` → `subdomain=grammar-mentor`, `rootdomain=r1t.67c.mytemp.website`
→ key = **`grammar-mentor_r1t.67c.mytemp.website`**

### B.3 Delete a **subdomain**

```bash
curl -sk -u "USER:PASS" -G \
  --data-urlencode "cpanel_jsonapi_apiversion=2" \
  --data-urlencode "cpanel_jsonapi_module=SubDomain" \
  --data-urlencode "cpanel_jsonapi_func=delsubdomain" \
  --data-urlencode "domain=api.example.com" \
  "https://132.148.178.39:2083/json-api/cpanel"
```

A success response contains `result: 1` and a reason like *"The subdomain … has been removed."*

### B.4 Delete an **addon domain**

```bash
curl -sk -u "USER:PASS" -G \
  --data-urlencode "cpanel_jsonapi_apiversion=2" \
  --data-urlencode "cpanel_jsonapi_module=AddonDomain" \
  --data-urlencode "cpanel_jsonapi_func=deladdondomain" \
  --data-urlencode "domain=example.com" \
  --data-urlencode "subdomain=example_r1t.67c.mytemp.website" \
  "https://132.148.178.39:2083/json-api/cpanel"
```

> If you get *"The subdomain X does not correspond to Y"*, your `subdomain` key is wrong —
> re-check step **B.2** and use the `<subdomain>_<rootdomain>` form exactly.

### B.5 Order of operations
1. Delete **subdomains** that sit under a domain you're removing (B.3).
2. Delete the **addon domains** (B.4).
3. Re-run **B.1** to confirm they're gone.
4. Optionally SSH in and delete the now-orphaned folders (they won't regenerate):
   ```bash
   ssh gr41l1kzrrhf@132.148.178.39
   rm -rf ~/public_html/<domain>
   ```

---

## Method C — SSH (what works and what doesn't)

You **can** SSH in for file operations and read-only cPanel info, but **not** for domain
deletion:

```bash
ssh gr41l1kzrrhf@132.148.178.39

# WORKS — read-only domain listing:
uapi DomainInfo list_domains

# WORKS — file management:
ls ~/public_html
rm -rf ~/public_html/<orphaned-domain-folder>

# DOES NOT WORK in this CageFS jail:
#   cpapi2 AddonDomain deladdondomain ...   -> "Failed to execute /usr/local/cpanel/cpanel"
#   uapi SubDomain delsubdomain ...         -> function not present in this cPanel build
```

So: use SSH for files, and **Method A or B for the actual domain removal.**

---

## Verification checklist

- [ ] `DomainInfo/list_domains` (or the Domains UI) no longer lists the removed domains.
- [ ] `public_html/<domain>` folders are gone and stay gone after a few minutes.
- [ ] The site no longer resolves (DNS zone removed).

---

## Important side effects to communicate before deleting

- **DNS zone is removed** → the domain stops resolving to this server.
- **Email/MX for that domain stops** → any mailboxes on that domain will no longer receive
  mail. Export/migrate mailboxes first if they matter.
- **SSL certificate** for that domain is dropped.
- Deletion is **not reversible** from cPanel — you'd have to re-add the domain and
  re-upload files/DNS. Keep a backup (e.g. `tar -czf backup.tgz ~/public_html/<domain>`)
  before removing anything important.

---

## Security note on credentials

Never hard-code the cPanel password in scripts, files, or git. Instead:

```bash
read -s -p "cPanel password: " PASS && export PASS   # prompts without echoing
curl -sk -u "gr41l1kzrrhf:$PASS" "https://132.148.178.39:2083/execute/DomainInfo/list_domains"
unset PASS
```

Rotate the cPanel password if it has ever been shared in plain text.
