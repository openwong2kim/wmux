// SPDX-License-Identifier: MIT
import React from 'react';
import { createRoot } from 'react-dom/client';
import { MoaMascot } from '../../src/renderer/components/Moa/MoaMascot';
import type { MoaMascotState } from '../../src/shared/moa';
const states: MoaMascotState[] = ['idle', 'working', 'needs-you', 'done'];
function Preview() {
  return <main><style>{`*{box-sizing:border-box}body{margin:0;background:#eceef8;font:15px system-ui;color:#292544}main{--text-muted:#8E9BEF;--accent-yellow:#FFD574;padding:48px;max-width:1040px;margin:auto}h1{font-size:36px;margin:0 0 10px}p{color:#696482}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin:32px 0}.card{text-align:center;background:white;border-radius:22px;padding:25px 12px}.dark{background:#232237;color:#ecebff;--text-muted:#b8b2d6;--accent-yellow:#ffd574}.sizes{display:flex;align-items:center;justify-content:center;gap:16px;height:48px}h2{font-size:15px;font-weight:600}.note{margin-top:24px}`}</style>
    <h1>Moa · your lavender companion</h1><p>Original MIT SVG · Move the pointer over Moa to meet its gaze.</p>
    {[false, true].map((dark) => <section key={String(dark)} className="grid">{states.map((state) => <article key={state} className={`card ${dark ? 'dark' : ''}`}><MoaMascot state={state} size={144} label={`Moa ${state}`} /><h2>{state}</h2><div className="sizes"><MoaMascot state={state} size={20}/><MoaMascot state={state} size={28}/><MoaMascot state={state} size={48}/></div></article>)}</section>)}
    <p className="note">Four real wmux states · 20 / 28 / 48 / 144 px · OS and Moa reduced-motion support</p>
  </main>;
}
const root = document.getElementById('root');
if (root) createRoot(root).render(<Preview />);
