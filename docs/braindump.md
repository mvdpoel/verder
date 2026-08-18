# Verder — Project Braindump

> Captured 2026-08-17, dictated by Martin. Raw intent — this is the source of truth for the "why"; specs come later.

## Who

- **Martin van der Poel**, 44, senior engineer, tech/AI savvy, programming since age 9.
- Dutch, but prefers English; may fall back to Dutch for terms he doesn't know in English.
- Multiple companies in the past that failed badly. After his partner died of cancer, everything slid. Several attempts to sort it out failed for one reason or another.

## The situation

- A few months ago Martin **voluntarily applied at VerderGroep for "Bewindvoering"** (official government process: financial responsibilities handed over to an administrator for a period; they control all payments and settlements with debtors).
- Debt is both **private and from previous businesses**.
- Goal: **WSNP** (Wet Sanering Natuurlijke Personen) — government debt settlement. All salary is taken except a tiny margin for groceries. Debtors are notified and asked to accept X amount over **18 months**; a judge can force acceptance if they refuse. Once that process starts, the 18-month timer counts down.
- **Court has accepted the application; onboarding has started**: handing over all documents, invoices, passport, etc. so VerderGroep can inventory the exact situation. Lots of requests will flow both ways.

## Why this project exists

The previous organization Martin worked with **messed up badly**. Never again:

- Build an **irrefutable, compelling case** — only the irrefutable truth.
- **Log every contact moment**: physical meetings, video calls, email, phone calls, WhatsApp, voicemail — any channel.
  - Who, when, where, what was discussed, who got which tasks.
  - Are tasks clear, ambiguous, already available?
- **Data quality is extremely important.** Essentially a very strong audit log.
- Also a **provider of documents and knowledge**: financial records, ex-partners, kids — eventually a complete knowledge base about Martin.

## The product vision

A web application (latest React framework; maybe React Native later for mobile utilities) with:

### 1. Audit log / logbook
- Every communication logged carefully, from any source.
- The agent can append to it.

### 2. Proactive agent (digital assistant between Martin and VerderGroep)
- Tracks Gmail, tasks, scanned-files folder on the NAS.
- Example flow: an email comes in requesting documents →
  - If the agent already has them: reply directly with attachment, or a download link if too big for email.
  - If not: message Martin to ask, or suggest based on partial data ("maybe email X", "call this number", "scan this"), automating work for Martin **and** VerderGroep.

### 3. Knowledge graph about Martin
- Personal information, all debts, all contracts (employment, house rental, energy, …), all subscriptions.
- VerderGroep will want this overview and will cancel everything except bare essentials (internet, mobile phone).
- There are too many subscriptions; Martin has lost track. Collect full details per subscription.
- Subscription statuses: **mandatory, allowed, requested, to-cancel, canceled**.
- On a subscription page Martin can enter an explanation why something should stay, or suggest an alternative.
- Concrete example: **Google Workspace** (paid, for martin@vanderpoel.pro custom domain) → could migrate to a free email service, but only after mass-cleaning a mailbox with hundreds of thousands of emails. Clear example of a **blocker-until-task-complete**.

### 4. Task management
- Tasks for Martin, for VerderGroep teams, or for individuals involved in the process.

### 5. User management
- Martin is the only **admin** role; can create users.
- Role system: start super basic, extend when it matters.
- Invite via **one-time magic link** by email or WhatsApp → user sets password → optional 2FA (TOTP, fingerprint/passkey).

### 6. Dashboard
- Assigned tasks, latest added documents, updates from the agent, a general timeline of milestones divided into stages.

## Memory architecture (for agent accuracy)

Huge amount of data. Use **multiple memory systems, each for its strength**:

- Markdown wiki (OKF format).
- Possibly an actual knowledge-graph DB for certain questions / data / reasoning directions.
- RAG with **reranking** for optimal retrieval accuracy elsewhere.

## The Golden Rule (LAW)

> Whenever AI is involved in this project it must always try to **self-improve**: learn from executions, mistakes, errors, warnings, performance tweaks, and result-accuracy improvements.

## Tone of voice (very important)

- **Towards Martin** (in Claude Code and in the agent): best friend helping without judgement; support and encourage. Assistant, guide, coach. This is a difficult topic for him — treat it with care.
- **Towards any other user** (expected: VerderGroep staff, possibly others): very professional, short and simple, friendly and polite — official communication style.

## Infrastructure

- All services installed and hosted on the **homelab machine** on the local network.
- **Cloudflared tunnel** already running there, plus a CF API key.
- Fast disk, memory, CPU; **AMD Radeon 16 GB VRAM GPU with ROCm**; **Ollama** already installed for open-source models.
- Self-improvement idea: **nightly job** checking Ollama/HuggingFace for new versions of the open-source models in use.
