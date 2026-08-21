#!/usr/bin/env node
/**
 * ForkPage — GitHub Pages 子路径资源适配
 * 用法: node fix-pages-base.mjs <outDir> <basePath>
 * basePath 例: /my-repo/
 *
 * - 相对路径 ./ ../ 不改
 * - http(s): // data: mailto: 不改
 * - 已带 base 前缀的不改
 * - HTML/CSS 中 /xxx 绝对路径 → /repo/xxx
 * - 注入或纠正 <base href>
 */
import fs from "node:fs";
import path from "node:path";

const outDir = process.argv[2];
const base = normalizeBase(process.argv[3] || "/");

if (!outDir || !fs.existsSync(outDir)) {
  console.warn("[fix-pages-base] 目录不存在，跳过:", outDir);
  process.exit(0);
}

if (base === "/") {
  console.log("[fix-pages-base] base=/ ，跳过");
  process.exit(0);
}

const TEXT_EXT = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
  ".svg",
  ".xml",
  ".txt",
  ".map",
  ".webmanifest",
]);

let changed = 0;
walk(outDir, (file) => {
  const ext = path.extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) return;
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  if (raw.includes("\u0000")) return;
  let next = raw;
  try {
    if (ext === ".html" || ext === ".htm") next = fixHtml(next, base);
    else if (ext === ".css") next = fixCss(next, base);
    else next = fixGeneric(next, base);
  } catch {
    return;
  }
  if (next !== raw) {
    try {
      fs.writeFileSync(file, next);
      changed++;
    } catch {
      /* skip */
    }
  }
});

console.log("[fix-pages-base] base=%s files=%d", base, changed);

function normalizeBase(b) {
  let s = String(b).trim() || "/";
  if (!s.startsWith("/")) s = "/" + s;
  if (!s.endsWith("/")) s += "/";
  return s;
}

function walk(dir, fn) {
  for (const name of fs.readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, fn);
    else fn(p);
  }
}

function alreadyPrefixed(u, base) {
  const b = base.replace(/\/$/, "");
  return u === b || u.startsWith(b + "/") || u.startsWith(base);
}

function shouldSkipUrl(u, base) {
  if (!u) return true;
  const s = u.trim();
  if (!s.startsWith("/")) return true;
  if (s.startsWith("//")) return true;
  if (alreadyPrefixed(s, base)) return true;
  return false;
}

function withBase(u, base) {
  const m = u.match(/^([^?#]*)([?#].*)?$/);
  const pathPart = m[1];
  const rest = m[2] || "";
  if (pathPart === "/") return base.replace(/\/?$/, "/") + (rest ? rest.slice(1) : "");
  return base.replace(/\/$/, "") + pathPart + rest;
}

function rewriteAttrs(content, base) {
  return content.replace(
    /(\b(?:src|href|poster|data-src|content)=)(["'])(\/.*?)(\2)/gi,
    (match, attr, q, url) => {
      if (shouldSkipUrl(url, base)) return match;
      if (/^\/(https?:|mailto:|tel:)/i.test(url)) return match;
      return attr + q + withBase(url, base) + q;
    }
  );
}

function fixCss(css, base) {
  return css.replace(/url\((["']?)(\/[^)'"]+)\1\)/g, (match, q, u) => {
    if (shouldSkipUrl(u, base)) return match;
    return `url(${q}${withBase(u, base)}${q})`;
  });
}

function fixGeneric(text, base) {
  // 常见打包目录的根绝对路径
  return text.replace(
    /(["'])\/(assets|static|css|js|img|images|media|fonts|favicon\.ico)\b/g,
    (match, q, folder) => {
      const trial = "/" + folder;
      if (alreadyPrefixed(trial, base)) return match;
      return q + base.replace(/\/$/, "") + "/" + folder;
    }
  );
}

function fixHtml(html, base) {
  let out = rewriteAttrs(html, base);
  out = fixCss(out, base);

  if (!/<base\s/i.test(out)) {
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(
        /<head([^>]*)>/i,
        `<head$1>\n  <base href="${base}">`
      );
    } else {
      out = `<!DOCTYPE html><head><base href="${base}"></head>\n` + out;
    }
  } else {
    out = out.replace(
      /<base\s+[^>]*href=(["'])[^"']*\1[^>]*>/i,
      `<base href="${base}">`
    );
  }
  return out;
}
