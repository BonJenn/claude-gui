import { marked } from "marked";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("go", go);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("md", markdown);
hljs.registerLanguage("plaintext", plaintext);
hljs.registerLanguage("python", python);
hljs.registerLanguage("py", python);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("rs", rust);
hljs.registerLanguage("sh", shell);
hljs.registerLanguage("shell", shell);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("tsx", typescript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("yml", yaml);

marked.setOptions({
  gfm: true,
  breaks: false,
});

// Use marked's `marked.use` for a renderer with inline syntax highlighting
// and a minimal sanitizer that blocks javascript: urls.
marked.use({
  renderer: {
    code(this: unknown, token) {
      const t = token as { text: string; lang?: string };
      const lang = (t.lang || "").toLowerCase();
      let html: string;
      if (lang && hljs.getLanguage(lang)) {
        html = hljs.highlight(t.text, { language: lang, ignoreIllegals: true }).value;
      } else {
        html = escapeHtml(t.text);
      }
      const langClass = lang ? ` class="hljs language-${lang}"` : ' class="hljs"';
      return `<pre><code${langClass}>${html}</code></pre>`;
    },
    link(this: unknown, token) {
      const t = token as { href: string; title?: string | null; text: string };
      const safe = isSafeUrl(t.href) ? t.href : "#";
      const title = t.title ? ` title="${escapeAttr(t.title)}"` : "";
      return `<a href="${escapeAttr(safe)}"${title}>${t.text}</a>`;
    },
  },
});

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function isSafeUrl(href: string): boolean {
  if (!href) return false;
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith("javascript:") || trimmed.startsWith("data:")) return false;
  return true;
}

const mdCache = new Map<string, string>();

export function compileMarkdown(text: string, repo?: string): string {
  if (!text) return "";
  const key = repo ? `${repo}\x00${text}` : text;
  const hit = mdCache.get(key);
  if (hit) return hit;
  try {
    let html = marked.parse(text, { async: false }) as string;
    if (repo) html = linkifyPrRefs(html, repo);
    if (mdCache.size > 5000) mdCache.clear();
    mdCache.set(key, html);
    return html;
  } catch (err) {
    console.error("markdown compile failed", err);
    return `<p>${escapeHtml(text)}</p>`;
  }
}

const PR_RE = /\b(?:PR|pr|pull(?:\s+request)?)\s*#?(\d+)\b/g;

// Walk the parsed HTML body, replace "PR #123" / "PR#123" / "pull request 123"
// references in text nodes with real anchors. Skips code, pre, and existing
// anchors so we never mangle syntax highlighting or double-link something.
function linkifyPrRefs(html: string, repo: string): string {
  const doc = new DOMParser().parseFromString(
    `<div id="r">${html}</div>`,
    "text/html",
  );
  const root = doc.getElementById("r");
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  let cur = walker.nextNode();
  while (cur) {
    const parent = (cur as Text).parentElement;
    if (parent && !parent.closest("a, code, pre")) {
      textNodes.push(cur as Text);
    }
    cur = walker.nextNode();
  }

  for (const node of textNodes) {
    const text = node.data;
    PR_RE.lastIndex = 0;
    if (!PR_RE.test(text)) continue;
    PR_RE.lastIndex = 0;
    const frag = doc.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = PR_RE.exec(text))) {
      const [match, num] = m;
      const offset = m.index;
      if (offset > last) {
        frag.appendChild(doc.createTextNode(text.slice(last, offset)));
      }
      const a = doc.createElement("a");
      a.setAttribute("href", `https://github.com/${repo}/pull/${num}`);
      a.textContent = match;
      frag.appendChild(a);
      last = offset + match.length;
    }
    if (last < text.length) {
      frag.appendChild(doc.createTextNode(text.slice(last)));
    }
    node.parentNode?.replaceChild(frag, node);
  }

  return root.innerHTML;
}
