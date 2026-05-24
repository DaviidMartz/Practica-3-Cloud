/**
 * src/index.js — Cloudflare Worker: Price Tracker Amazon
 *
 * Traducció del projecte Python (Pràctica 1) a JavaScript per a Cloudflare Workers.
 *
 * Canvis principals respecte al codi Python original:
 *  - SMTP/Gmail (smtplib) → API de Resend (Workers no suporta connexions TCP directes)
 *  - BeautifulSoup (HTML parsing) → regex sobre el text HTML (no hi ha DOM al Worker)
 *  - Fitxers locals (subscripcions.json) → eliminat a la v1 (requeriria Cloudflare KV)
 *  - Mòduls Python separats → tot en un sol fitxer JS (estructura Workers)
 *  - Secrets en secrets.json → secrets de Wrangler (env.RESEND_API_KEY, env.EMAIL_FROM)
 */

// ─── Utilitats HTTP (equivalent a http_ajudants.py) ──────────────────────────

function respostaJson(dades, codi = 200) {
  return new Response(JSON.stringify(dades, null, 2), {
    status: codi,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ─── Validació (equivalent a config.py) ──────────────────────────────────────

function validaParams(searchParams) {
  let url   = (searchParams.get('url_amazon')   || '').trim();
  const email = (searchParams.get('email_usuari') || '').trim();
  const preu  = (searchParams.get('preu_limit')   || '').trim();

  if (!url) return 'Falta url_amazon';
  if (!url.startsWith('http')) {
    // Auto-afegeix https:// igual que el codi Python original
    url = 'https://' + url;
    searchParams.set('url_amazon', url);
  }
  if (!url.includes('amazon.')) return "La URL no és d'Amazon";
  if (!email) return 'Falta email_usuari';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return 'Format de correu no vàlid';
  if (preu) {
    const n = parseFloat(preu.replace(',', '.'));
    if (isNaN(n) || n < 0) return 'preu_limit ha de ser un número positiu';
  }
  return null;
}

// ─── Scraping Amazon (equivalent a amazon.py) ────────────────────────────────

function netejaUrl(url) {
  // Elimina paràmetres de tracking que poden activar CAPTCHA
  const m = url.match(/\/[^?#]*\/dp\/([A-Z0-9]{10})/);
  if (m) {
    const domini = url.match(/amazon\.([a-z.]+)/);
    const base = domini ? `amazon.${domini[1]}` : 'amazon.es';
    return `https://www.${base}/dp/${m[1]}`;
  }
  return url;
}

function parsejaPreu(text) {
  // Mateixa lògica que _parseja_preu() a amazon.py
  let net = text.trim().replace(/[€$£\s\u00a0]/g, '');
  if (net.includes(',') && net.includes('.')) {
    net = net.replace(/\./g, '').replace(',', '.');
  } else if (net.includes(',')) {
    net = net.replace(',', '.');
  }
  const n = parseFloat(net);
  return isNaN(n) || n <= 0 ? null : Math.round(n * 100) / 100;
}

async function obtePreuAmazon(urlInput) {
  const urlNeta = netejaUrl(urlInput);

  // Mateixos headers que HEADERS a amazon.py per simular Chrome
  const headers = {
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'es-ES,es;q=0.9',
    'DNT':                       '1',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Sec-Fetch-User':            '?1',
  };

  let resp;
  try {
    resp = await fetch(urlNeta, { headers });
  } catch {
    return { error: 'connexio' };
  }

  // Reintent amb URL mínima /dp/ASIN si 404 (igual que amazon.py)
  if (resp.status === 404) {
    const m = urlInput.match(/\/dp\/([A-Z0-9]{10})/);
    const d = urlInput.match(/amazon\.([a-z.]+)/);
    if (m && d) {
      try {
        resp = await fetch(`https://www.amazon.${d[1]}/dp/${m[1]}`, { headers });
      } catch {
        return { error: 'amazon_http_404' };
      }
    }
  }

  if (!resp.ok) return { error: `amazon_http_${resp.status}` };

  const html = await resp.text();

  // Detecció de CAPTCHA (igual que amazon.py)
  if (html.includes('/errors/validateCaptcha')) return { error: 'captcha_detectat' };

  // Extracció del preu: busquem spans .a-offscreen amb valors monetaris.
  // Equivalent als SELECTORS de amazon.py, però amb regex ja que no tenim DOM.
  const rx = /<span[^>]*class="[^"]*a-offscreen[^"]*"[^>]*>([^<]*)<\/span>/g;
  let match;
  while ((match = rx.exec(html)) !== null) {
    const preu = parsejaPreu(match[1]);
    if (preu !== null) return { preu, url_neta: urlNeta };
  }

  return { error: 'preu_no_trobat' };
}

// ─── Correu (equivalent a correu.py — ara via API Resend en lloc de SMTP) ────
//
// CANVI IMPORTANT: smtplib no existeix a Workers (no hi ha connexions TCP raw).
// Resend ofereix una API REST idèntica en funcionalitat, amb tier gratuït.
// Setup: npx wrangler secret put RESEND_API_KEY
//        npx wrangler secret put EMAIL_FROM  (ha d'estar verificat a resend.com)

function blocPreu(preu) {
  return `<div style="background:#f5f0e8;border-radius:8px;padding:16px 20px;margin-bottom:16px">
    <p style="margin:0 0 4px;font-size:11px;color:#8a7a6a;letter-spacing:1px;text-transform:uppercase">Preu actual</p>
    <p style="margin:0;font-size:38px;font-weight:bold;color:#9a3412">${preu.toFixed(2)} €</p>
  </div>`;
}

function blocPreuDoble(preu, limit, etiqueta) {
  return `<div style="display:flex;gap:12px;margin-bottom:16px">
    <div style="flex:1;background:#f5f0e8;border-radius:8px;padding:16px 20px">
      <p style="margin:0 0 4px;font-size:11px;color:#8a7a6a;letter-spacing:1px;text-transform:uppercase">Preu actual</p>
      <p style="margin:0;font-size:30px;font-weight:bold;color:#9a3412">${preu.toFixed(2)} €</p>
      <p style="margin:4px 0 0;font-size:12px;color:#8a7a6a">${etiqueta}</p>
    </div>
    <div style="flex:1;background:#fff;border:1px solid #e0d4be;border-radius:8px;padding:16px 20px">
      <p style="margin:0 0 4px;font-size:11px;color:#8a7a6a;letter-spacing:1px;text-transform:uppercase">El teu límit</p>
      <p style="margin:0;font-size:30px;font-weight:bold;color:#1a1410">${limit.toFixed(2)} €</p>
    </div>
  </div>`;
}

async function enviaCorreu(env, destinatari, url, preu, limit) {
  let assumpte, bannerColor, titol, blocExtra, blocPreuHtml;

  if (limit === null) {
    assumpte     = `📦 Price Tracker — Preu actual: ${preu.toFixed(2)} €`;
    bannerColor  = '#9a3412';
    titol        = 'Aquí tens el preu actual';
    blocPreuHtml = blocPreu(preu);
    blocExtra    = "<p style='color:#5a4a3a;margin:0 0 20px'>Has fet la consulta sense límit de preu.</p>";
  } else if (preu <= limit) {
    const baixada = (limit - preu).toFixed(2);
    assumpte     = `🔔 Preu baixat! Ara a ${preu.toFixed(2)} € (estalvies ${baixada} €)`;
    bannerColor  = '#2d6a2d';
    titol        = 'El preu ha baixat del teu límit!';
    blocPreuHtml = blocPreuDoble(preu, limit, '✅ Per sota del límit');
    blocExtra    = `<p style='color:#2d6a2d;font-size:15px;margin:0 0 20px'>Estalvies <strong>${baixada} €</strong> respecte al teu límit.</p>`;
  } else {
    const diferencia = (preu - limit).toFixed(2);
    assumpte     = `📊 Price Tracker — Preu actual ${preu.toFixed(2)} € (falta ${diferencia} €)`;
    bannerColor  = '#7a5c2a';
    titol        = 'Encara no ha baixat prou';
    blocPreuHtml = blocPreuDoble(preu, limit, '⏳ Per sobre del límit');
    blocExtra    = `<p style='color:#7a5c2a;font-size:15px;margin:0 0 20px'>El preu ha de baixar <strong>${diferencia} €</strong> més per activar la teva alerta.</p>`;
  }

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f5f0e8;font-family:Georgia,serif">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table width="500" style="background:#fffcf7;border:1px solid #e0d4be;border-radius:10px;overflow:hidden">
  <tr><td style="background:${bannerColor};padding:24px 32px">
    <p style="margin:0;color:rgba(255,255,255,.75);font-size:11px;letter-spacing:2px;text-transform:uppercase">Price Tracker · Amazon</p>
    <h1 style="margin:8px 0 0;color:#fff;font-size:20px;font-weight:normal">${titol}</h1>
  </td></tr>
  <tr><td style="padding:28px 32px">
    ${blocExtra}
    ${blocPreuHtml}
    <a href="${url}" style="display:inline-block;background:${bannerColor};color:#fff;padding:12px 22px;border-radius:6px;text-decoration:none;font-size:14px;margin-top:8px">Veure producte a Amazon →</a>
  </td></tr>
  <tr><td style="padding:14px 32px;border-top:1px solid #e0d4be;text-align:center">
    <p style="margin:0;color:#bbb;font-size:11px">Missatge automàtic · Price Tracker</p>
  </td></tr>
</table></td></tr></table></body></html>`;

  const resendResp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from:    env.EMAIL_FROM,
      to:      destinatari,
      subject: assumpte,
      html,
      text: `${titol}\nPreu actual: ${preu.toFixed(2)} €\n${url}`,
    }),
  });

  if (!resendResp.ok) {
    const err = await resendResp.text();
    return { errorResend: `${resendResp.status}: ${err}` };
  }
  return null;
}

// ─── Handler principal (equivalent a gestor.py) ──────────────────────────────

export default {
  async fetch(request, env) {
    const { searchParams } = new URL(request.url);
    const userAgent = request.headers.get('User-Agent') || '';

    // Sense paràmetres → servim la UI (comportament idèntic a gestor.py)
    if ([...searchParams.keys()].length === 0) {
      return userAgent.startsWith('Mozilla')
        ? new Response(UI_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
        : respostaJson({ error: 'Falta url_amazon' }, 400);
    }

    // Validació
    const error = validaParams(searchParams);
    if (error) return respostaJson({ error }, 400);

    let urlAmazon = searchParams.get('url_amazon').trim();
    if (!urlAmazon.startsWith('http')) urlAmazon = 'https://' + urlAmazon;
    const email       = searchParams.get('email_usuari').trim();
    const preuLimitRaw = searchParams.get('preu_limit') || '';
    const limit       = preuLimitRaw ? parseFloat(preuLimitRaw.replace(',', '.')) : null;

    // Consulta preu a Amazon
    const res = await obtePreuAmazon(urlAmazon);
    if (res.error) {
      const codis = { timeout: 504, captcha_detectat: 422, preu_no_trobat: 422 };
      return respostaJson({ error: res.error }, codis[res.error] || 502);
    }

    const preu    = res.preu;
    const urlNeta = res.url_neta || urlAmazon;

    // Envia correu
    const errCorreu = await enviaCorreu(env, email, urlNeta, preu, limit);
    if (errCorreu) return respostaJson({ error: errCorreu.errorResend }, 502);

    // Resposta JSON (mateixa estructura que gestor.py)
    const resposta = { preu_actual: preu, url_consultada: urlNeta, alerta_enviada: true };
    if (limit !== null) {
      resposta.preu_limit     = limit;
      resposta.per_sota_limit = preu <= limit;
    }
    return respostaJson(resposta);
  },
};

// ─── UI HTML (inline — equivalent a ui.html carregat des del disc) ───────────
// Nota: la URL del fetch canvia de `/?url_amazon=...` a la mateixa ruta relativa,
// que funciona igual tant en local (localhost:8787) com en producció (workers.dev).

const UI_HTML = `<!DOCTYPE html>
<html lang="ca">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Price Tracker</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    :root{--bg:#f5f0e8;--card:#fffcf7;--ink:#1a1410;--rust:#9a3412;--rust2:#7a2a0e;--dim:#8a7a6a;--brd:#e0d4be}
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'DM Sans',sans-serif;background:var(--bg);min-height:100vh;display:grid;place-items:center;padding:1.5rem}
    body::before{content:'';position:fixed;inset:0;background:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(154,52,18,.13),transparent);pointer-events:none}
    main{background:var(--card);border:1px solid var(--brd);border-radius:12px;padding:2.2rem 2rem;width:100%;max-width:420px;box-shadow:0 8px 40px rgba(26,20,16,.09)}
    h1{font-family:'DM Serif Display',serif;font-size:2rem;color:var(--ink);letter-spacing:-.02em;margin-bottom:.3rem}
    p.sub{color:var(--dim);font-size:.88rem;padding-bottom:1.4rem;border-bottom:1px solid var(--brd);margin-bottom:1.4rem}
    label{display:block;font-size:.75rem;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--dim);margin-bottom:.35rem;margin-top:1.1rem}
    input{width:100%;padding:.7rem .9rem;border:1.5px solid var(--brd);border-radius:6px;font:inherit;font-size:.95rem;color:var(--ink);background:#fff;transition:border-color .2s}
    input:focus{outline:none;border-color:var(--rust)}
    input::placeholder{color:#c0b09a}
    button{width:100%;margin-top:1.5rem;padding:.85rem;background:var(--rust);color:#fff;font:600 .95rem 'DM Sans',sans-serif;border:none;border-radius:6px;cursor:pointer;transition:background .18s,transform .12s}
    button:hover{background:var(--rust2)} button:active{transform:scale(.98)}
    #r{margin-top:1.1rem;padding:.85rem 1rem;border-radius:6px;border:1px solid transparent;font-size:.9rem;line-height:1.5;display:none}
    #r.vis{display:block;background:rgba(154,52,18,.06);border-color:rgba(154,52,18,.15)}
    #r.ok{background:rgba(30,100,30,.07);border-color:rgba(30,100,30,.22)}
    #r.err{background:rgba(154,20,20,.07);border-color:rgba(154,20,20,.22)}
  </style>
</head>
<body>
<main>
  <h1>Price Tracker</h1>
  <p class="sub">Avisa'm quan el preu d'Amazon baixi del meu límit.</p>
  <label for="u">URL del producte Amazon</label>
  <input id="u" type="url" placeholder="https://www.amazon.es/dp/..." required>
  <label for="e">Correu electrònic</label>
  <input id="e" type="email" placeholder="nom@exemple.com" required>
  <label for="l">Preu límit en € (opcional)</label>
  <input id="l" type="number" step="0.01" min="0" placeholder="Ex: 29.99">
  <button onclick="cerca()">Consultar preu</button>
  <div id="r"></div>
</main>
<script>
async function cerca() {
  const u=document.getElementById('u').value, e=document.getElementById('e').value, l=document.getElementById('l').value;
  const r=document.getElementById('r');
  r.className='vis'; r.textContent='⏳ Consultant Amazon...';
  try {
    const res=await fetch('/?url_amazon='+encodeURIComponent(u)+'&email_usuari='+encodeURIComponent(e)+'&preu_limit='+encodeURIComponent(l));
    const d=await res.json();
    if(d.error){r.className='vis err';r.textContent='❌ '+d.error;}
    else if(d.alerta_enviada){r.className='vis ok';r.textContent='✅ Alerta enviada! Preu actual: '+d.preu_actual+' €';}
    else{r.className='vis';r.textContent='📊 Preu actual: '+d.preu_actual+' € — per sobre del límit ('+d.preu_limit+' €)';}
  } catch{r.className='vis err';r.textContent='❌ Error de connexió.';}
}
</script>
</body>
</html>`;