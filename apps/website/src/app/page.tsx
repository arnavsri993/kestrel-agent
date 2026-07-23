"use client";

import { motion, useReducedMotion } from "motion/react";
import mediaRegistry from "../data/media-registry.json";
import { AmbientMedia, type VisualAsset } from "../components/AmbientMedia";
import { ApprovalScene, ContextScene, TeacherScene } from "../components/ProductScenes";

const assets = mediaRegistry as VisualAsset[];
const hero = assets.find((asset) => asset.id === "hero-signal-field")!;
const cta = assets.find((asset) => asset.id === "cta-resolution-field")!;

const stages = ["Notice", "Retrieve", "Plan", "Approve", "Act", "Verify"];

const capabilityExamples = [
  { trigger: "A repository is shared", work: "Inspect the project, plan the change, implement it, and run the relevant checks.", boundary: "Local changes remain reviewable." },
  { trigger: "A folder is provided", work: "Understand the contents, apply the requested transformation, and organize the outputs.", boundary: "Access stays scoped to the selected folder." },
  { trigger: "A scheduling request arrives", work: "Compare commitments, recommend an option, and prepare the reply and event.", boundary: "External communication waits for approval." },
  { trigger: "The task is unfamiliar", work: "Discover available tools and skills, construct a plan, and verify the result.", boundary: "Missing capability is reported, not invented." }
];

const securityControls = [
  ["01", "Encrypted memory fields", "AES-256-GCM protects stored content. The database key stays in macOS secure storage and never enters the renderer."],
  ["02", "Sandboxed interface", "No Node integration, raw filesystem, or database handle. IPC remains narrow and schema-validated."],
  ["03", "Scoped permissions", "Selected folders are allowlisted. Accessibility, screen recording, and Apple Events stay off until needed."],
  ["04", "Untrusted-content boundary", "Email and web content remain data. Deterministic policy—not text inside that content—governs tools."],
  ["05", "Inspectable activity", "Observation, context, proposal, approval, execution, and verification appear as separate audit events."],
  ["06", "Deletable context", "The architecture includes source inspection, correction, deletion, and channel-separated storage."]
];

const releaseChecks = [
  ["available", "Unsigned Apple Silicon development app"],
  ["pending", "Developer ID signing and notarization"],
  ["pending", "Gatekeeper verification on packaged artifacts"],
  ["pending", "Intel hardware and universal-build verification"],
  ["pending", "Public download, repository, and update host"]
];

function Arrow() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M14 6l6 6-6 6" /></svg>;
}

function Brand() {
  return <span className="brand-lockup"><img className="brand-mark" src="/brand/workstrand-mark.svg" alt="" /><strong>Workstrand</strong><small>local work agent</small></span>;
}

const navItems = [
  ["Decision", "#decision"],
  ["Memory", "#memory"],
  ["Control", "#control"],
  ["Architecture", "#architecture"]
];

export default function Home() {
  const reduced = useReducedMotion();

  return <>
    <a className="skip-link" href="#content">Skip to product story</a>

    <header className="site-header">
      <nav className="site-nav" aria-label="Primary navigation">
        <a className="site-brand" href="#top" aria-label="Workstrand home"><Brand /></a>
        <div className="nav-links">
          {navItems.map(([label, href]) => <a key={href} href={href}>{label}</a>)}
        </div>
        <a className="nav-release" href="#release">Release status <Arrow /></a>
        <details className="nav-menu">
          <summary>Menu</summary>
          <div>
            {navItems.map(([label, href]) => <a key={href} href={href} onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>{label}</a>)}
            <a href="#release" onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}>Release status</a>
          </div>
        </details>
      </nav>
    </header>

    <main id="content">
      <section className="hero" id="top" aria-labelledby="hero-title">
        <AmbientMedia asset={hero} className="hero-media" />
        <div className="hero-copy">
          <span className="kicker">One local place for the whole job</span>
          <h1 id="hero-title">Bring the outcome.<span>Workstrand handles the work.</span></h1>
          <p>Choose a project and say what done looks like. Workstrand can inspect, build, research, run, and verify—then pause before consequential action.</p>
          <div className="hero-actions">
            <a className="primary-cta" href="#decision">See one verified workflow <Arrow /></a>
            <a className="text-cta" href="#safety">Read the safety model</a>
          </div>
          <small className="availability">Development preview · mocked connectors · no signed public download yet</small>
        </div>
        <div className="hero-product"><TeacherScene /></div>
        <motion.div className="hero-thread" initial={reduced ? false : { scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ duration: 1.05, delay: 0.18, ease: [0.22, 1, 0.36, 1] }} />
      </section>

      <ol className="stage-strip" aria-label="Workstrand decision path">
        {stages.map((stage, index) => <li key={stage}><span>{String(index + 1).padStart(2, "0")}</span><strong>{stage}</strong>{index < stages.length - 1 && <i aria-hidden="true" />}</li>)}
      </ol>

      <section className="narrative-section decision-section" id="decision" aria-labelledby="decision-title">
        <div className="section-index">01 / ONE COMPLETE DECISION</div>
        <div className="section-heading">
          <h2 id="decision-title">A request arrives.<span>A reviewable answer is already waiting.</span></h2>
          <p>A teacher offered Friday or Monday. Workstrand checked the calendar, found Friday swim, protected the weekend for study, and prepared the exact changes—without sending them.</p>
        </div>
        <div className="teacher-workflow">
          <ol className="workflow-rail" aria-label="Scheduling decision evidence">
            {["Email read", "Options extracted", "Calendar compared", "Monday recommended", "Reply drafted", "Event prepared", "Approval requested"].map((item, index) => <li key={item} className={index === 6 ? "active" : "done"}><span>{index < 6 ? "✓" : "07"}</span><strong>{item}</strong></li>)}
          </ol>
          <TeacherScene />
        </div>
      </section>

      <section className="memory-section" id="memory" aria-labelledby="memory-title">
        <div className="memory-copy">
          <div className="section-index">02 / CONTEXT WITH A BOUNDARY</div>
          <h2 id="memory-title">Remember less.<span>Use the part that changes the answer.</span></h2>
          <p>When a DJI controller reports a connection problem, generic troubleshooting starts with a cable and restart. Workstrand can avoid repeating steps already tried and weigh the phone&apos;s developer beta instead.</p>
          <blockquote>“Because the phone still charges, DJI Fly launches, and another cable already failed, software compatibility now outranks a dead controller.”</blockquote>
          <div className="memory-note"><span>Retrieval scope</span><strong>Decision-changing context only</strong><small>Unrelated personal memory stays outside the working context.</small></div>
        </div>
        <ContextScene />
      </section>

      <section className="control-section" id="control" aria-labelledby="control-title">
        <div className="control-copy" id="safety">
          <div className="section-index">03 / CONTROL THAT STAYS VISIBLE</div>
          <h2 id="control-title">Autonomy stops where consequence starts.</h2>
          <p>Every action receives a policy level. External communication pauses by default. Sensitive submissions and high-consequence changes always require stronger review.</p>
          <ol className="risk-ladder" aria-label="Workstrand action levels">
            <li><span>0</span><div><strong>Read and prepare</strong><small>No external side effect</small></div></li>
            <li><span>1</span><div><strong>Reversible local work</strong><small>Configurable approval</small></div></li>
            <li className="active"><span>2</span><div><strong>External communication</strong><small>Approval by default</small></div></li>
            <li><span>3</span><div><strong>Sensitive submission</strong><small>Explicit review every time</small></div></li>
            <li><span>4</span><div><strong>High consequence</strong><small>Strong confirmation</small></div></li>
          </ol>
        </div>
        <div className="demo-wrap">
          <span className="demo-label">Try the local approval state</span>
          <ApprovalScene />
          <p className="demo-boundary">This interaction changes only the preview in your browser. It has no agent endpoint.</p>
        </div>
      </section>

      <section className="capability-section" aria-labelledby="capability-title">
        <div className="section-index">04 / ONE GRAMMAR, DIFFERENT WORK</div>
        <div className="section-heading compact-heading">
          <h2 id="capability-title">The plan changes.<span>The safety grammar does not.</span></h2>
          <p>Workstrand uses available tools and installable skills to plan unfamiliar work. Each example below is a task shape—not a claim of a dedicated production integration.</p>
        </div>
        <div className="capability-ledger">
          {capabilityExamples.map((example, index) => <article key={example.trigger}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <h3>{example.trigger}</h3>
            <p>{example.work}</p>
            <small>{example.boundary}</small>
          </article>)}
        </div>
      </section>

      <section className="security-section" id="architecture" aria-labelledby="architecture-title">
        <div className="section-index">05 / LOCAL-FIRST BY ARCHITECTURE</div>
        <div className="section-heading compact-heading">
          <h2 id="architecture-title">Personal context has a perimeter.</h2>
          <p>The current vertical slice implements these controls. A production release remains gated on packaged security, signing, and hardware verification.</p>
        </div>
        <div className="security-ledger">
          {securityControls.map(([index, title, copy]) => <article key={title}><span>{index}</span><h3>{title}</h3><p>{copy}</p></article>)}
        </div>
      </section>

      <section className="release-section" id="release" aria-labelledby="release-title">
        <AmbientMedia asset={cta} />
        <div className="release-copy">
          <div className="section-index">06 / RELEASE READINESS</div>
          <h2 id="release-title">The development app is real.<span>The public release is not ready to pretend.</span></h2>
          <p>A signed download stays unavailable until the distribution gates are complete. The website will not turn pending infrastructure into a fake call to action.</p>
          <div className="release-actions" aria-label="Unavailable release actions">
            <button type="button" disabled>Download for macOS <small>not signed yet</small></button>
            <button type="button" disabled>View repository <small>publishing later</small></button>
          </div>
        </div>
        <div className="release-panel">
          <p className="release-version"><span>Current version</span><strong>0.1.0 development</strong></p>
          <ul className="release-checklist">
            {releaseChecks.map(([status, label]) => <li key={label} className={status}><span>{status === "available" ? "Ready" : "Pending"}</span><strong>{label}</strong></li>)}
          </ul>
        </div>
      </section>
    </main>

    <footer className="site-footer">
      <div className="footer-brand"><Brand /></div>
      <p>A local-first workbench for coding, research, automation, files, and verified delivery—with consequential actions kept visible.</p>
      <div className="footer-links">{navItems.map(([label, href]) => <a key={href} href={href}>{label}</a>)}<a href="#release">Release</a></div>
      <div className="provenance"><strong>Build provenance</strong><p>fal is used only by deliberate development scripts for optional website atmosphere. It is absent from the public runtime and is not a Workstrand capability.</p></div>
    </footer>
  </>;
}
