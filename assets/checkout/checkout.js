/**
 * Página de checkout (checkout.html) — Pix via backend api-capa-de-sofa.
 * Depende de assets/checkout/config.js: API_URL, SIZE_OPTIONS, COLOR_OPTIONS,
 * COMPARE_AT_PRICE, MAX_QTY, PRODUCT_*, SHIPPING_*, RETURNS_TEXT, WARRANTY_TEXT.
 *
 * Etapas: 1 dados+entrega -> 2 Pix (QR + copia e cola, polling) -> 3 confirmação.
 * Recebe o kit escolhido na página do produto pela URL
 * (?kit=3.cinza.vermelho&q=1) ou, como reserva, pelo sessionStorage ("pd_order").
 */
(function () {
  "use strict";

  var POLL_MS = 5000;
  var REQUEST_TIMEOUT_MS = 30000;
  var KEY_ORDER = "pd_order";
  var KEY_PIX = "pd_pix";
  var TRACKED = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "src", "sck", "fbclid", "gclid", "gbraid", "wbraid", "ttclid"];
  var TRACKING_MAX_AGE = 90 * 864e5; // prazo de atribuição do Google
  var UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO"];

  var order = null; // { kit: {size, color1, color2, quantity}, tracking: {} }
  var pix = null; // { transactionId, qrCode, qrImage, expirationDate, email, firstName, total }
  var pollTimer = null;
  var expiresAt = 0;
  var busy = false;
  var lastZip = "";

  /* ---------------- Eventos (GTM/dataLayer) ---------------- */

  window.dataLayer = window.dataLayer || [];

  function track(event, extra) {
    window.dataLayer.push(Object.assign({ event: event }, extra || {}));
  }

  function $(id) { return document.getElementById(id); }
  function digits(v) { return String(v || "").replace(/\D/g, ""); }
  function brl(v) { return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

  /* ---------------- Armazenamento (pode falhar em modo privado) ----------------
     Sessão + localStorage: fechar a aba ou abrir o checkout de novo não perde o Pix nem o pedido. */

  function store(key, value) {
    var v = JSON.stringify(value);
    try { sessionStorage.setItem(key, v); } catch (e) { /* segue */ }
    try { localStorage.setItem(key, v); } catch (e) { /* segue */ }
  }
  function load(key) {
    var v = null;
    try { v = sessionStorage.getItem(key); } catch (e) { /* noop */ }
    if (!v) { try { v = localStorage.getItem(key); } catch (e) { /* noop */ } }
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  function drop(key) {
    try { sessionStorage.removeItem(key); } catch (e) { /* noop */ }
    try { localStorage.removeItem(key); } catch (e) { /* noop */ }
  }

  /* UTMs e gclid/gbraid/wbraid guardados pela página do produto na chegada do anúncio. */
  function trackingFromLanding() {
    try {
      var s = JSON.parse(sessionStorage.getItem("pd_tracking") || "null");
      if (s && Object.keys(s).length) return s;
    } catch (e) { /* noop */ }
    try {
      var l = JSON.parse(localStorage.getItem("pd_tracking") || "null");
      if (l && l.v && Date.now() - l.t < TRACKING_MAX_AGE) return l.v;
    } catch (e) { /* noop */ }
    return {};
  }

  /* ---------------- Pedido (kit escolhido) ---------------- */

  function findSize(id) { return SIZE_OPTIONS.filter(function (s) { return s.id === Number(id); })[0] || null; }
  function findColor(id) { return COLOR_OPTIONS.filter(function (c) { return c.id === id; })[0] || null; }

  function normalizeKit(k) {
    if (!k) return null;
    var qty = Math.round(Number(k.quantity) || 1);
    if (!findSize(k.size) || !findColor(k.color1) || !findColor(k.color2)) return null;
    return { size: Number(k.size), color1: k.color1, color2: k.color2, quantity: Math.min(Math.max(qty, 1), MAX_QTY) };
  }

  function trackingFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var out = {};
    TRACKED.forEach(function (k) { if (params.has(k)) out[k] = params.get(k); });
    return out;
  }

  function readOrder() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get("kit");
    var kit = null;
    if (raw) {
      var parts = raw.split(".");
      kit = normalizeKit({ size: parts[0], color1: parts[1], color2: parts[2], quantity: params.get("q") });
    }
    var saved = load(KEY_ORDER);
    if (!kit && saved) kit = normalizeKit(saved.kit);
    if (!kit) return null;
    var tracking = trackingFromUrl();
    if (!Object.keys(tracking).length && saved && saved.tracking && Object.keys(saved.tracking).length) tracking = saved.tracking;
    if (!Object.keys(tracking).length) tracking = trackingFromLanding();
    return { kit: kit, tracking: tracking };
  }

  function saveOrder() { store(KEY_ORDER, order); }

  function unitPrice() { return findSize(order.kit.size).price; }
  function total() { return Math.round(unitPrice() * order.kit.quantity * 100) / 100; }

  /* ---------------- Resumo do pedido ---------------- */

  function kitHtml(kit) {
    var c1 = findColor(kit.color1);
    var c2 = findColor(kit.color2);
    function cover(c, n) {
      return (
        '<figure class="co-kit-item">' +
        '<span class="co-kit-img"><img src="' + c.image + '" alt="' + PRODUCT_NAME + " na cor " + c.label + '" width="600" height="600"></span>' +
        '<figcaption><span class="co-kit-n">' + n + "ª capa</span><strong>" + c.label + "</strong></figcaption>" +
        "</figure>"
      );
    }
    return (
      '<div class="co-kit-grid">' + cover(c1, 1) + '<span class="co-kit-plus" aria-hidden="true">+</span>' + cover(c2, 2) + "</div>" +
      '<p class="co-kit-gift"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M19 12v9H5v-9M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>' +
      "<span><strong>+ 2 almofadas inclusas</strong> de brinde</span></p>"
    );
  }

  function kitDescription(kit) {
    return (
      findSize(kit.size).label + " · 1ª capa " + findColor(kit.color1).label + " · 2ª capa " + findColor(kit.color2).label +
      (kit.quantity > 1 ? " · " + kit.quantity + " kits" : "")
    );
  }

  function renderSummary() {
    var kit = order.kit;
    var c1 = findColor(kit.color1);
    var c2 = findColor(kit.color2);
    $("co-kit").innerHTML =
      '<p class="co-kit-title"><strong>' + PRODUCT_NAME + "</strong> · " + findSize(kit.size).label +
      (kit.quantity > 1 ? " · " + kit.quantity + " kits" : "") + "</p>" + kitHtml(kit);
    $("co-mini-thumbs").innerHTML = '<img src="' + c1.image + '" alt=""><img src="' + c2.image + '" alt="">';
    $("co-product-name").textContent = PRODUCT_NAME + " · " + findSize(kit.size).label;
    $("co-product-meta").textContent = PRODUCT_SUBTITLE;
    $("co-qty-val").textContent = String(kit.quantity);
    Array.prototype.forEach.call(document.querySelectorAll(".co-qty-btn"), function (b) {
      var d = Number(b.getAttribute("data-qty"));
      b.disabled = (d < 0 && kit.quantity <= 1) || (d > 0 && kit.quantity >= MAX_QTY);
    });

    var t = total();
    var compare = COMPARE_AT_PRICE * kit.quantity;
    $("co-compare").textContent = compare > t ? brl(compare) : "";
    $("co-subtotal").textContent = brl(t);
    $("co-save").textContent = compare > t ? brl(compare - t) : "";
    $("co-save").closest(".co-totals-row").hidden = !(compare > t);
    $("co-total").textContent = brl(t);
    $("co-total-mini").textContent = brl(t);
    $("co-assure-ship").innerHTML = "<strong>" + SHIPPING_TEXT + "</strong> · " + SHIPPING_DETAIL + ".";
    $("co-assure-return").innerHTML = "<strong>" + RETURNS_TEXT + "</strong> · " + WARRANTY_TEXT + ".";
    $("co-ship-note").textContent = SHIPPING_DETAIL.charAt(0).toUpperCase() + SHIPPING_DETAIL.slice(1) + " · Correios";
    if (!busy) $("co-submit-label").textContent = "Finalizar pedido · " + brl(t);

    var back = "index.html" + queryWithTracking();
    $("co-edit").href = back;
    $("co-back").href = back;
  }

  function queryWithTracking() {
    var p = new URLSearchParams();
    Object.keys(order ? order.tracking : {}).forEach(function (k) { p.set(k, order.tracking[k]); });
    var s = p.toString();
    return s ? "?" + s : "";
  }

  function changeQty(delta) {
    if (busy) return;
    var q = order.kit.quantity + delta;
    if (q < 1 || q > MAX_QTY) return;
    order.kit.quantity = q;
    saveOrder();
    renderSummary();
    // mantém a URL em dia (recarregar a página não perde a quantidade)
    var params = new URLSearchParams(window.location.search);
    params.set("q", String(q));
    history.replaceState(null, "", "?" + params.toString());
  }

  function toggleSummary() {
    var box = $("co-summary");
    var open = !box.classList.contains("is-open");
    box.classList.toggle("is-open", open);
    $("co-summary-toggle").setAttribute("aria-expanded", open ? "true" : "false");
  }

  /* ---------------- Etapas ---------------- */

  function setStep(n) {
    var steps = document.querySelectorAll(".co-step");
    Array.prototype.forEach.call(steps, function (el, i) {
      var num = i + 1;
      var done = num < n || n === 3;
      el.classList.toggle("is-done", done);
      el.classList.toggle("is-current", !done && num === n);
      el.querySelector(".co-step-dot").textContent = done ? "✓" : String(num);
    });
    $("co-qty").classList.toggle("is-locked", n > 1);
    // depois dos dados, o resumo fica compacto no celular (o Pix aparece primeiro)
    var box = $("co-summary");
    box.classList.toggle("is-compact", n > 1);
    if (n > 1) {
      box.classList.remove("is-open");
      $("co-summary-toggle").setAttribute("aria-expanded", "false");
    }
  }

  function show(which) {
    $("co-form").hidden = which !== "form";
    $("co-pix").hidden = which !== "pix";
    $("co-paid").hidden = which !== "paid";
    $("co-empty").hidden = which !== "empty";
    $("co-layout").classList.toggle("is-paid", which === "paid");
    $("co-layout").classList.toggle("is-empty", which === "empty");
    window.scrollTo(0, 0);
    var h = { form: "co-h1-form", pix: "co-h1-pix", paid: "co-h1-paid" }[which];
    if (h) $(h).focus({ preventScroll: true });
  }

  /* ---------------- Máscaras e validação ---------------- */

  function maskCpf(v) {
    return digits(v).slice(0, 11)
      .replace(/^(\d{3})(\d)/, "$1.$2")
      .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
      .replace(/\.(\d{3})(\d)/, ".$1-$2");
  }
  function maskPhone(v) {
    var d = digits(v).slice(0, 11);
    if (d.length <= 2) return d ? "(" + d : "";
    if (d.length <= 6) return "(" + d.slice(0, 2) + ") " + d.slice(2);
    if (d.length <= 10) return "(" + d.slice(0, 2) + ") " + d.slice(2, 6) + "-" + d.slice(6);
    return "(" + d.slice(0, 2) + ") " + d.slice(2, 7) + "-" + d.slice(7);
  }
  function maskZip(v) {
    var d = digits(v).slice(0, 8);
    return d.length > 5 ? d.slice(0, 5) + "-" + d.slice(5) : d;
  }

  function validCpf(raw) {
    var cpf = digits(raw);
    if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
    for (var t = 9; t < 11; t++) {
      var sum = 0;
      for (var i = 0; i < t; i++) sum += Number(cpf[i]) * (t + 1 - i);
      if (((sum * 10) % 11) % 10 !== Number(cpf[t])) return false;
    }
    return true;
  }

  var VALIDATORS = {
    name: function (v) {
      v = v.trim();
      return v.length >= 5 && v.split(/\s+/).length >= 2 ? "" : "Informe seu nome e sobrenome.";
    },
    email: function (v) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim()) ? "" : "Confira o e-mail digitado.";
    },
    phone: function (v) {
      var d = digits(v);
      return (d.length === 10 || d.length === 11) && /^[1-9][1-9]/.test(d) ? "" : "Informe o celular com DDD.";
    },
    cpf: function (v) { return validCpf(v) ? "" : "CPF inválido."; },
    zip: function (v) { return digits(v).length === 8 ? "" : "Informe o CEP com 8 números."; },
    street: function (v) { return v.trim() ? "" : "Informe a rua."; },
    number: function (v) { return v.trim() ? "" : "Informe o número."; },
    neighborhood: function (v) { return v.trim() ? "" : "Informe o bairro."; },
    city: function (v) { return v.trim() ? "" : "Informe a cidade."; },
    state: function (v) { return UFS.indexOf(v) > -1 ? "" : "Escolha o estado."; }
  };

  function paint(el, msg, touched) {
    var wrap = el.closest(".co-field");
    wrap.classList.toggle("has-error", !!msg);
    wrap.classList.toggle("is-valid", !msg && touched && !!el.value.trim());
    wrap.querySelector(".co-field-msg").textContent = msg || "";
    if (msg) el.setAttribute("aria-invalid", "true");
    else el.removeAttribute("aria-invalid");
  }

  function checkField(el, touched) {
    var fn = VALIDATORS[el.name];
    if (!fn) return "";
    var msg = fn(el.value);
    paint(el, msg, touched);
    return msg;
  }

  function validateAll() {
    var first = null;
    Object.keys(VALIDATORS).forEach(function (name) {
      var el = $("co-form").elements[name];
      if (checkField(el, true) && !first) first = el;
    });
    return first;
  }

  /* ---------------- CEP automático (ViaCEP) ---------------- */

  function lookupZip(zip) {
    if (zip === lastZip) return;
    lastZip = zip;
    var wrap = $("co-zip").closest(".co-field");
    wrap.classList.add("is-loading");
    fetch("https://viacep.com.br/ws/" + zip + "/json/")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (zip !== lastZip) return;
        if (!d || d.erro) {
          paint($("co-zip"), "CEP não encontrado. Confira ou preencha o endereço.", true);
          return;
        }
        var f = $("co-form").elements;
        if (d.logradouro) f.street.value = d.logradouro;
        if (d.bairro) f.neighborhood.value = d.bairro;
        if (d.localidade) f.city.value = d.localidade;
        if (d.uf && UFS.indexOf(d.uf) > -1) f.state.value = d.uf;
        ["zip", "street", "neighborhood", "city", "state"].forEach(function (n) { checkField(f[n], true); });
        (d.logradouro ? f.number : f.street).focus();
      })
      .catch(function () { /* sem conexão com o ViaCEP: o cliente preenche manualmente */ })
      .then(function () { wrap.classList.remove("is-loading"); });
  }

  /* ---------------- Envio do pedido ---------------- */

  function showBanner(msg) {
    var b = $("co-banner");
    b.textContent = msg || "";
    b.hidden = !msg;
  }

  function setBusy(on) {
    busy = on;
    var btn = $("co-submit");
    btn.disabled = on;
    btn.classList.toggle("is-loading", on);
    $("co-submit-label").textContent = on ? "Gerando seu Pix…" : "Finalizar pedido · " + brl(total());
  }

  function buildPayload() {
    var f = $("co-form").elements;
    return {
      customer: {
        name: f.name.value.trim(),
        email: f.email.value.trim(),
        phone: digits(f.phone.value),
        cpf: digits(f.cpf.value),
        address: {
          zip: digits(f.zip.value),
          street: f.street.value.trim(),
          number: f.number.value.trim(),
          complement: f.complement.value.trim(),
          neighborhood: f.neighborhood.value.trim(),
          city: f.city.value.trim(),
          state: f.state.value
        }
      },
      kit: order.kit,
      tracking: order.tracking
    };
  }

  function items() {
    return [{
      item_id: "capa-sofa-" + order.kit.size,
      item_name: PRODUCT_NAME,
      item_variant: kitDescription(Object.assign({}, order.kit, { quantity: 1 })),
      price: unitPrice(),
      quantity: order.kit.quantity
    }];
  }

  function onSubmit(e) {
    e.preventDefault();
    if (busy) return;
    showBanner("");

    var firstBad = validateAll();
    if (firstBad) {
      showBanner("Confira os campos destacados para continuar.");
      firstBad.scrollIntoView({ behavior: "smooth", block: "center" });
      firstBad.focus({ preventScroll: true });
      return;
    }

    setBusy(true);
    track("add_payment_info", { currency: "BRL", value: total(), payment_type: "pix" });

    var payload = buildPayload();
    var ctrl = typeof AbortController === "function" ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, REQUEST_TIMEOUT_MS);

    fetch(API_URL + "/api/pix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (body) { return { ok: r.ok, body: body }; });
      })
      .then(function (res) {
        if (!res.ok) throw new Error(res.body.error || "Não foi possível gerar o Pix agora. Tente novamente.");
        var saved = {
          transactionId: res.body.transactionId,
          qrCode: res.body.qrCode,
          qrImage: res.body.qrImage,
          expirationDate: res.body.expirationDate,
          email: payload.customer.email,
          firstName: payload.customer.name.split(/\s+/)[0],
          total: typeof res.body.amount === "number" ? res.body.amount : total()
        };
        store(KEY_PIX, saved);
        showPix(saved, false);
      })
      .catch(function (err) {
        var network = err instanceof TypeError || (err && err.name === "AbortError");
        showBanner(network ? "Não conseguimos conectar ao servidor de pagamento. Verifique sua internet e tente de novo." : err.message);
        $("co-banner").scrollIntoView({ behavior: "smooth", block: "center" });
      })
      .then(function () {
        clearTimeout(timer);
        setBusy(false);
      });
  }

  /* ---------------- Tela do Pix ---------------- */

  function showPix(p, resumed) {
    pix = p;
    var t = Date.parse(p.expirationDate);
    expiresAt = isNaN(t) ? Date.now() + 30 * 60 * 1000 : t;

    $("co-pix-amount").textContent = brl(p.total || total());
    $("co-pix-valid").textContent =
      "Código válido até " + new Date(expiresAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) + ".";
    $("co-qr").src = p.qrImage;
    $("co-code").value = p.qrCode;
    $("co-copy").textContent = "Copiar código Pix";
    $("co-copy").disabled = false;
    $("co-wait").hidden = false;
    $("co-pix-note").hidden = false;
    $("co-expired").hidden = true;
    $("co-wait-text").textContent = "Aguardando a confirmação do pagamento…";

    setStep(2);
    show("pix");
    if (!resumed) track("pix_generated", { currency: "BRL", value: p.total || total(), transaction_id: p.transactionId });

    stopPolling();
    if (resumed) poll();
    else pollTimer = setTimeout(poll, POLL_MS);
  }

  function stopPolling() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  function poll() {
    stopPolling();
    if (!pix) return;
    // Passou do vencimento: confere o status real uma última vez (o Pix pode ter sido pago no fim do prazo).
    if (Date.now() > expiresAt) return finalCheck();
    var id = pix.transactionId;

    fetch(API_URL + "/api/pix/" + encodeURIComponent(id) + "/status")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!pix || pix.transactionId !== id) return;
        if (d.status === "paid") return onPaid();
        if (d.status === "failed" || d.status === "expired" || d.status === "refunded") return markExpired();
        pollTimer = setTimeout(poll, POLL_MS);
      })
      .catch(function () {
        if (pix && pix.transactionId === id) pollTimer = setTimeout(poll, POLL_MS);
      });
  }

  function finalCheck() {
    var id = pix && pix.transactionId;
    if (!id) return markExpired();
    fetch(API_URL + "/api/pix/" + encodeURIComponent(id) + "/status")
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!pix || pix.transactionId !== id) return;
        if (d.status === "paid") return onPaid();
        if (d.status === "pending") {
          // ainda pendente logo após o vencimento: mais alguns minutos de tolerância antes de desistir
          if (Date.now() - expiresAt < 10 * 60 * 1000) { pollTimer = setTimeout(finalCheck, POLL_MS * 2); return; }
        }
        markExpired();
      })
      .catch(function () {
        if (pix && pix.transactionId === id && Date.now() - expiresAt < 10 * 60 * 1000) pollTimer = setTimeout(finalCheck, POLL_MS * 2);
        else markExpired();
      });
  }

  function markExpired() {
    stopPolling();
    drop(KEY_PIX);
    $("co-wait").hidden = true;
    $("co-pix-note").hidden = true;
    $("co-copy").disabled = true;
    $("co-expired").hidden = false;
    pix = null;
  }

  function copyCode() {
    var input = $("co-code");
    var btn = $("co-copy");
    function done() {
      btn.textContent = "Código copiado!";
      setTimeout(function () { btn.textContent = "Copiar código Pix"; }, 2500);
    }
    function fallback() {
      input.select();
      input.setSelectionRange(0, input.value.length);
      try { document.execCommand("copy"); done(); } catch (e) { btn.textContent = "Selecione e copie o código acima"; }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(input.value).then(done, fallback);
    } else {
      fallback();
    }
  }

  function newPix() {
    drop(KEY_PIX);
    pix = null;
    setStep(1);
    show("form");
  }

  /* ---------------- Confirmação ---------------- */

  function onPaid() {
    stopPolling();
    var p = pix;
    pix = null;
    drop(KEY_PIX);
    drop(KEY_ORDER);

    var paidTotal = p.total || total();
    $("co-paid-lead").textContent = "Obrigado, " + p.firstName + "! Recebemos o seu pagamento via Pix.";
    $("co-paid-code").textContent = p.transactionId.slice(0, 8).toUpperCase();
    $("co-paid-total").textContent = brl(paidTotal);
    $("co-paid-email").textContent = p.email;
    $("co-paid-kit").innerHTML = kitHtml(order.kit);
    $("co-paid-desc").textContent = PRODUCT_NAME + " · " + kitDescription(order.kit);

    setStep(3);
    show("paid");

    var flag = "pd_purchase_" + p.transactionId;
    var already = false;
    try { already = !!localStorage.getItem(flag); localStorage.setItem(flag, "1"); } catch (e) { /* noop */ }
    if (!already) {
      track("purchase", { transaction_id: p.transactionId, currency: "BRL", value: paidTotal, shipping: 0, items: items() });
    }
  }

  /* ---------------- Init ---------------- */

  function bindForm() {
    var form = $("co-form");
    var uf = $("co-state");
    UFS.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s;
      o.textContent = s;
      uf.appendChild(o);
    });

    form.addEventListener("input", function (e) {
      var el = e.target;
      if (el.name === "cpf") el.value = maskCpf(el.value);
      if (el.name === "phone") el.value = maskPhone(el.value);
      if (el.name === "zip") {
        el.value = maskZip(el.value);
        if (digits(el.value).length === 8) lookupZip(digits(el.value));
        else lastZip = "";
      }
      // corrige a mensagem enquanto digita, sem marcar erro antes da hora
      if (el.closest(".co-field") && el.closest(".co-field").classList.contains("has-error")) checkField(el, false);
    });
    form.addEventListener("focusout", function (e) {
      if (e.target.name && VALIDATORS[e.target.name] && e.target.value !== "") checkField(e.target, true);
    });
    form.addEventListener("change", function (e) {
      if (e.target.name && VALIDATORS[e.target.name]) checkField(e.target, true);
    });
    form.addEventListener("submit", onSubmit);
  }

  function init() {
    order = readOrder();
    var saved = load(KEY_PIX);

    if (!order) {
      $("co-summary").hidden = true;
      show("empty");
      return;
    }

    saveOrder();
    renderSummary();
    bindForm();
    $("co-summary-toggle").addEventListener("click", toggleSummary);
    $("co-qty").addEventListener("click", function (e) {
      var b = e.target.closest(".co-qty-btn");
      if (b && !$("co-qty").classList.contains("is-locked")) changeQty(Number(b.getAttribute("data-qty")));
    });
    $("co-copy").addEventListener("click", copyCode);
    $("co-new-pix").addEventListener("click", newPix);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && pix) poll();
    });

    if (saved && saved.transactionId) {
      // Pix já gerado (mesmo vencido): retoma a tela e consulta o status real antes de decidir.
      showPix(saved, true);
    } else {
      drop(KEY_PIX);
      setStep(1);
      show("form");
      track("begin_checkout", { currency: "BRL", value: total(), items: items() });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
