"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { sitePath } from "../lib/site-path";

export function TeacherScene() {
  const reduced = useReducedMotion();
  return <div className="teacher-scene" aria-label="Kestrel scheduling workflow preview">
    <div className="scene-topbar"><span><b><img src={sitePath("/brand/workstrand-mark.svg")} alt="" /></b> Kestrel</span><small>waiting for approval</small></div>
    <motion.div className="scene-signal" initial={reduced ? false : { scaleX: 0 }} whileInView={{ scaleX: 1 }} viewport={{ once: true }} transition={{ duration: .8, ease: [.22, 1, .36, 1] }} />
    <div className="scene-body">
      <div className="scene-message"><span>Teacher email</span><strong>Friday or Monday?</strong><p>Choose a date for the Algebra II test.</p></div>
      <div className="scene-calendar"><span>Friday · 3:30 PM</span><strong>Swim practice</strong><small>Verified recurring event</small></div>
      <div className="scene-decision"><small>Recommendation</small><strong>Monday looks better.</strong><p>Friday is compressed by swim. Monday leaves the weekend open to study.</p><div aria-hidden="true"><span>Edit</span><span>Approve plan</span></div></div>
    </div>
  </div>;
}

export function ContextScene() {
  const facts = ["DJI Mini 3", "phone controller", "iPhone 16 Pro", "iOS developer beta", "phone still charges", "DJI Fly launches", "second cable tested", "restart attempted"];
  return <div className="context-scene" aria-label="Example of scoped personal context retrieval"><div className="context-orbit">{facts.map((fact, index) => <span key={fact} style={{ "--i": index } as React.CSSProperties}>{fact}</span>)}<b>RC not connected</b></div><div className="context-answer"><small>Relevant context only</small><p>Software compatibility now ranks above a dead controller or cable.</p></div></div>;
}

type PreviewState = "prepared" | "editing" | "approved" | "rejected";

export function ApprovalScene() {
  const reduced = useReducedMotion();
  const [state, setState] = useState<PreviewState>("prepared");
  const [recommendation, setRecommendation] = useState<"Monday" | "Friday">("Monday");
  const [restoreFocus, setRestoreFocus] = useState(false);
  const primaryAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!restoreFocus) return;
    primaryAction.current?.focus();
    setRestoreFocus(false);
  }, [restoreFocus, state]);

  const transition = (next: PreviewState) => {
    setRestoreFocus(true);
    setState(next);
  };

  const reset = () => {
    setRecommendation("Monday");
    transition("prepared");
  };

  return <motion.div
    className={`approval-scene is-${state}`}
    layout={!reduced}
    transition={{ duration: reduced ? 0 : 0.24, ease: [0.22, 1, 0.36, 1] }}
  >
    <header><span>Local approval preview</span><b>{state === "prepared" || state === "editing" ? "Level 2" : state}</b></header>

    {state === "editing" ? <div className="demo-editor">
      <small>Recommendation</small>
      <p>Choose the date shown in this local preview.</p>
      <div className="demo-options" aria-label="Preview recommendation">
        {(["Monday", "Friday"] as const).map((day) => <button key={day} type="button" aria-pressed={recommendation === day} onClick={() => setRecommendation(day)}>{day}</button>)}
      </div>
    </div> : <>
      <div><small>Reason</small><p>{recommendation === "Monday" ? "Monday avoids Friday swim and keeps the weekend open." : "Friday keeps the original week, but overlaps with swim practice."}</p></div>
      <div><small>Exact changes</small><p>Preview 1 reply · preview 1 event · prepare 2 study blocks</p></div>
    </>}

    <div className="demo-status" aria-live="polite">
      {state === "prepared" && <p>Review the exact reply and calendar change. Nothing has been sent.</p>}
      {state === "editing" && <p>Editing is local to this page. Return to review when the recommendation is ready.</p>}
      {state === "approved" && <p><strong>Preview approved.</strong> No email was sent and no event was created from this website.</p>}
      {state === "rejected" && <p><strong>Preview rejected.</strong> Nothing was sent or changed.</p>}
    </div>

    <footer>
      {state === "prepared" && <>
        <button type="button" onClick={() => transition("rejected")}>Reject preview</button>
        <button type="button" onClick={() => transition("editing")}>Edit recommendation</button>
        <button ref={primaryAction} type="button" className="action-primary" onClick={() => transition("approved")}>Approve preview</button>
      </>}
      {state === "editing" && <>
        <button type="button" onClick={() => transition("prepared")}>Cancel</button>
        <button ref={primaryAction} type="button" className="action-primary" onClick={() => transition("prepared")}>Return to review</button>
      </>}
      {(state === "approved" || state === "rejected") && <button ref={primaryAction} type="button" className="action-primary" onClick={reset}>Reset preview</button>}
    </footer>
  </motion.div>;
}
