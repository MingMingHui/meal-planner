/**
 * share.js
 * ----------------------------------------------------------------------------
 * Purpose: Renders a row of share buttons (meal plans, recipes, shopping
 *          lists, progress summaries) using the native Web Share API when
 *          available, with manual fallback buttons (WhatsApp, Facebook,
 *          Telegram, Email, Copy Link, Copy Text) otherwise.
 * Inputs:  A container element + {title, text, url}.
 * Outputs: DOM buttons wired with click handlers; no return value.
 * Depends on: ui.js (toast, icons).
 * ----------------------------------------------------------------------------
 */

import { ICONS, toast, escapeHTML } from './ui.js';

export function shareContent(container, { title = 'Health Meal Planning Agent', text = '', url = window.location.href } = {}) {
  if (!container) return;
  container.innerHTML = '';

  if (navigator.share) {
    const nativeBtn = document.createElement('button');
    nativeBtn.className = 'share-btn';
    nativeBtn.innerHTML = `${ICONS.share} Share`;
    nativeBtn.addEventListener('click', async () => {
      try { await navigator.share({ title, text, url }); }
      catch (e) { /* user cancelled — no-op */ }
    });
    container.appendChild(nativeBtn);
  }

  const encodedText = encodeURIComponent(`${text}`);
  const encodedUrl = encodeURIComponent(url);

  const targets = [
    { label: 'WhatsApp', href: `https://wa.me/?text=${encodedText}%20${encodedUrl}` },
    { label: 'Telegram', href: `https://t.me/share/url?url=${encodedUrl}&text=${encodedText}` },
    { label: 'Facebook', href: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}` },
    { label: 'Email', href: `mailto:?subject=${encodeURIComponent(title)}&body=${encodedText}%0A%0A${encodedUrl}` },
  ];

  targets.forEach(t => {
    const a = document.createElement('a');
    a.className = 'share-btn';
    a.href = t.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = t.label;
    container.appendChild(a);
  });

  const copyLinkBtn = document.createElement('button');
  copyLinkBtn.className = 'share-btn';
  copyLinkBtn.textContent = 'Copy link';
  copyLinkBtn.addEventListener('click', () => copyToClipboard(url, 'Link copied to clipboard.'));
  container.appendChild(copyLinkBtn);

  const copyTextBtn = document.createElement('button');
  copyTextBtn.className = 'share-btn';
  copyTextBtn.textContent = 'Copy text';
  copyTextBtn.addEventListener('click', () => copyToClipboard(text, 'Text copied to clipboard.'));
  container.appendChild(copyTextBtn);
}

async function copyToClipboard(value, successMessage) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast(successMessage, 'success');
  } catch (e) {
    toast('Could not copy to clipboard.', 'error');
  }
}
