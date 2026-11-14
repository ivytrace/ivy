const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A small server-rendered page (OAuth errors, unsubscribe) in the dashboard's dark look. */
export function simplePage(title: string, body: string, extra = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Ivy</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09090b;color:#fafafa;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
  main{max-width:28rem;margin:1rem;padding:2rem;border:1px solid #27272a;border-radius:.5rem;background:#0c0c0f}
  h1{font-size:1.25rem;margin:0 0 .5rem} p{color:#a1a1aa;line-height:1.5} a{color:#4ade80}
  button{background:#4ade80;color:#052e16;border:0;border-radius:.375rem;padding:.5rem 1rem;font-weight:600;cursor:pointer}
  .brand{color:#4ade80;font-weight:700;font-size:.875rem;margin-bottom:1rem}
</style></head>
<body><main><div class="brand">Ivy</div><h1>${esc(title)}</h1><p>${esc(body)}</p>${extra}</main></body></html>`;
}

export { esc as escapeHtml };
