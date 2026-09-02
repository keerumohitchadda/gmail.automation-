# Oracle Cloud Always Free — creating the server

Oracle's free tier is genuinely free forever, not a trial. It is also the fiddliest of
the options, and almost all of that difficulty is concentrated in three places. They
are called out below as **⚠ TRAP** — read those even if you skim everything else.

You only need this file to get an instance running with an IP. Everything after that
is `deploy.sh`.

---

## 1. Sign up

<https://www.oracle.com/cloud/free/>

- A credit or debit card is required **for identity verification only**. Oracle places
  a small temporary hold (around ₹85) and refunds it. Always Free resources are not
  billed.
- Indian cards are sometimes rejected at this step. If yours is, try a different card
  or a different browser before concluding it is broken — this is a known annoyance,
  not something you did wrong.

> ⚠ **TRAP 1 — your Home Region is permanent.**
> During signup Oracle asks for a Home Region. Pick **India South (Hyderabad)** or
> **India West (Mumbai)**. You can never change it afterwards, and Always Free
> resources only exist in your home region. Choosing a US region by accident means
> starting over with a new account.

Verification can take a few minutes to a few hours.

---

## 2. Create the instance

Console → hamburger menu → **Compute → Instances → Create instance**

**Name:** anything, e.g. `mailflow`

**Image and shape** → *Edit*:

- **Image:** Canonical Ubuntu **24.04**
- **Shape:** *Ampere* → `VM.Standard.A1.Flex`, set **1 OCPU** and **6 GB memory**

> ⚠ **TRAP 2 — "Out of host capacity".**
> Free ARM capacity is heavily contested and this error is common. Two ways through:
> - Try again at a quieter hour, or pick the other India region if you have not
>   created the instance yet.
> - Or switch the shape to **`VM.Standard.E2.1.Micro`** (AMD, 1 OCPU, 1 GB). It is
>   almost always available and it is *enough* — this app idles at well under 200 MB.
>   Slower to run `npm install`, identical once running.

**Networking:** leave the defaults. Make sure **Assign a public IPv4 address** is on.

**Add SSH keys** → choose **Paste public keys** and paste this exactly:

```
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIKGa59UeEg1zaoafqAz8weoSiuBWWfx55+20B8r3WyPh mailflow-deploy
```

This is the step that grants access for the deployment. It goes into a textarea rather
than a validated form field, so it is far more forgiving than GitHub's key box.

Click **Create**. Provisioning takes 1–2 minutes.

When it goes green, copy the **Public IP address** from the instance page.

---

## 3. Open the firewall — both halves of it

> ⚠ **TRAP 3 — there are two firewalls, and opening one does nothing.**
> This is why most Oracle instances appear completely dead on port 80 while SSH works
> fine. You must open the cloud-level Security List *and* the iptables rules on the
> instance itself.

**Half one — the cloud Security List (you do this in the console):**

Instance page → click the **Subnet** link → **Security Lists** → click the default
list → **Add Ingress Rules**. Add two:

| Source CIDR | IP Protocol | Destination Port |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

**Half two — iptables on the instance:** `deploy.sh` detects Oracle's rules and fixes
this automatically. You do not need to do anything, but this is what it runs:

```bash
sudo iptables -I INPUT 1 -p tcp --dport 80 -m conntrack --ctstate NEW -j ACCEPT
```

---

## 4. Connect and deploy

The default user on Oracle's Ubuntu images is `ubuntu`, not `root`:

```bash
ssh ubuntu@YOUR_PUBLIC_IP
```

Then clone and run the deployment:

```bash
git clone https://github.com/keerumohitchadda/gmail.automation-.git ~/src && sudo bash ~/src/deploy.sh mail.yourdomain.com
```

(The repo is private, so this prompts for GitHub credentials — see the deploy-key
section of [DEPLOY-HOSTINGER.md](DEPLOY-HOSTINGER.md), or just upload the bundle
instead. Despite the filename, that guide's server steps apply to any Ubuntu box.)

---

## What free actually gets you

Always Free, per Oracle's current terms:

- 2 OCPU / 12 GB total across Ampere A1 instances (halved from 4/24 in June 2026)
- 2 × AMD `E2.1.Micro` instances
- 200 GB block storage
- 10 TB/month outbound transfer

This app needs a rounding error of that. The main risk is not capacity, it is Oracle
changing the terms again — they did in 2026 with little notice, and instances over the
new limit were terminated. Keep the deployment reproducible (it is: this repo plus
`deploy.sh`) so moving hosts is an afternoon, not a rebuild.

---

## When it goes wrong

**SSH works, but the site never loads.** Trap 3 — you opened one firewall, not both.
Check the console Security List has the port 80 and 443 ingress rules.

**`Permission denied (publickey)` on SSH.** Wrong username. Oracle's Ubuntu images use
`ubuntu`, not `root` or `opc` (`opc` is for Oracle Linux).

**"Out of host capacity" every time.** Use `VM.Standard.E2.1.Micro` instead. It is
smaller and entirely sufficient here.

**Certbot fails.** DNS is not pointing at the instance yet. Add the A record, wait,
then run `sudo certbot --nginx -d mail.yourdomain.com`.
