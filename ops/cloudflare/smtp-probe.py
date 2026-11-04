#!/usr/bin/env python3
"""M1 SMTP probe — read what a sending MTA is actually told.

Runs from the homelab, which is the vantage point that MEASURED outbound 25 as
open (the Mac does not have it, and the earlier TransIP probe was invalidated
once by a host that blocked outbound 25 itself). Speaks SMTP by hand rather than
through smtplib's send_message, because the whole point is the response code at
each stage and smtplib raises them away.

The response that decides option C is the one after end-of-DATA. A 4xx there
means the sender queues and retries; a 5xx means the message bounces.

Usage:
    python3 smtp-probe.py <mx-host> <domain> [localpart ...]

Interleaves nothing and probes one host, because unlike the TransIP measurement
this is not a reachability question: the control is the `ok@` case, which must
return 250 in the same run for any other result to mean anything.
"""
import socket
import ssl
import sys
import time
import uuid

CRLF = "\r\n"


class Conv:
    def __init__(self, host, port=25, timeout=180):
        self.host = host
        self.sock = socket.create_connection((host, port), timeout=30)
        self.sock.settimeout(timeout)
        self.f = self.sock.makefile("rb")
        self.log = []

    def read(self):
        """Read one complete SMTP reply, honouring multiline continuations."""
        lines = []
        while True:
            raw = self.f.readline()
            if not raw:
                return "000", "connection closed by peer"
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            lines.append(line)
            if len(line) < 4 or line[3] != "-":
                break
        code = lines[-1][:3]
        return code, " | ".join(lines)

    def cmd(self, text, expect_reply=True):
        self.sock.sendall((text + CRLF).encode())
        if not expect_reply:
            return None, None
        code, full = self.read()
        self.log.append((text.split(" ")[0][:12], code, full))
        return code, full

    def starttls(self):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        self.sock = ctx.wrap_socket(self.sock, server_hostname=self.host)
        self.f = self.sock.makefile("rb")

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


def probe(mx, domain, local, sender):
    to = f"{local}@{domain}"
    mid = f"<m1-{local}-{uuid.uuid4().hex[:12]}@{sender.split('@')[1]}>"
    result = {"to": to, "msgid": mid, "stages": {}}
    c = None
    t0 = time.time()
    try:
        c = Conv(mx)
        code, full = c.read()
        result["stages"]["banner"] = (code, full)

        code, full = c.cmd("EHLO probe.vanderpoel.pro")
        result["stages"]["ehlo"] = (code, full)
        offers_tls = "STARTTLS" in full.upper()

        if offers_tls:
            code, full = c.cmd("STARTTLS")
            result["stages"]["starttls"] = (code, full)
            if code == "220":
                c.starttls()
                code, full = c.cmd("EHLO probe.vanderpoel.pro")
                result["stages"]["ehlo2"] = (code, full)

        code, full = c.cmd(f"MAIL FROM:<{sender}>")
        result["stages"]["mail_from"] = (code, full)

        code, full = c.cmd(f"RCPT TO:<{to}>")
        result["stages"]["rcpt_to"] = (code, full)
        if not code.startswith("2"):
            result["verdict"] = f"refused at RCPT TO with {code}"
            return result

        code, full = c.cmd("DATA")
        result["stages"]["data"] = (code, full)
        if not code.startswith("3"):
            result["verdict"] = f"refused at DATA with {code}"
            return result

        body = CRLF.join([
            f"From: M1 probe <{sender}>",
            f"To: <{to}>",
            f"Subject: m1 probe {local}",
            f"Message-ID: {mid}",
            "Date: " + time.strftime("%a, %d %b %Y %H:%M:%S +0000", time.gmtime()),
            "MIME-Version: 1.0",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            f"Measurement M1, case {local}. This message exists only to read the",
            "SMTP response code the sender is given. Nothing acts on it.",
            "",
        ])
        c.sock.sendall((body + CRLF + "." + CRLF).encode())
        code, full = c.read()
        result["stages"]["end_of_data"] = (code, full)
        result["verdict"] = f"end-of-DATA {code}"

        c.cmd("QUIT")
    except socket.timeout:
        result["verdict"] = f"TIMEOUT after {time.time() - t0:.0f}s"
    except Exception as e:
        result["verdict"] = f"{type(e).__name__}: {e}"
    finally:
        if c:
            c.close()
    result["seconds"] = round(time.time() - t0, 1)
    return result


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    mx, domain = sys.argv[1], sys.argv[2]
    locals_ = sys.argv[3:] or ["ok", "throw", "reject", "fetchbad"]
    sender = "probe@vanderpoel.pro"

    print(f"MX      : {mx}")
    print(f"domain  : {domain}")
    print(f"sender  : {sender}")
    print("=" * 78)
    for local in locals_:
        r = probe(mx, domain, local, sender)
        print(f"\n### {r['to']}   ({r.get('seconds', '?')}s)")
        for stage in ("banner", "ehlo", "starttls", "mail_from", "rcpt_to",
                      "data", "end_of_data"):
            if stage in r["stages"]:
                code, full = r["stages"][stage]
                shown = full if len(full) < 150 else full[:147] + "..."
                print(f"    {stage:<12} {code}  {shown}")
        print(f"    VERDICT      {r['verdict']}")
        time.sleep(3)
    print("\n" + "=" * 78)
    print("The line that decides option C is `end_of_data` for the failing cases.")
    print("4xx = sender queues and retries.  5xx = bounce.  250 = accepted and")
    print("the failure is invisible to the sender, which is its own finding.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
