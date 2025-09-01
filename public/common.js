
function $(sel, el=document){ return el.querySelector(sel); }
function $all(sel, el=document){ return Array.from(el.querySelectorAll(sel)); }
function copyText(text) {
  navigator.clipboard?.writeText(text);
}
function formatJoinURL(code){
  return `${location.origin}/ (PIN: ${code})`;
}
function timeStr(sec){ return `${sec}s`; }

// Simple confetti wrappers
function confettiBurst() {
  if (window.confetti) {
    confetti({ particleCount: 120, spread: 70, origin: { y: 0.6 } });
  }
}
