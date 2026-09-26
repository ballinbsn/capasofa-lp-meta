/**
 * Configuração do checkout (checkout.html) — Capa de Sofá Vicenza, Leve 2 Pague 1.
 * Tudo que muda de uma oferta para outra fica aqui.
 * Os preços abaixo são só para EXIBIR: quem define o valor cobrado é o backend
 * (api-capa-de-sofa/server.js). Se mudar preço, mude nos dois lugares.
 */

/* URL do backend no Railway (sem barra no final). Local: http://localhost:3000 */
var API_URL = "https://api-capa-de-sofa-production.up.railway.app";

var PRODUCT_NAME = "Capa de Sofá Vicenza";
var PRODUCT_SUBTITLE = "Kit Leve 2 Pague 1: 2 capas + 2 almofadas inclusas";

/* Tamanhos: preço do kit (2 capas + 2 almofadas) */
var SIZE_OPTIONS = [
  { id: 2, label: "2 Assentos", price: 87.9 },
  { id: 3, label: "3 Assentos", price: 87.9 },
  { id: 4, label: "4 Assentos", price: 97.9 },
  { id: 5, label: "5 Assentos", price: 107.9 }
];
var COMPARE_AT_PRICE = 175.9; // preço "de" mostrado riscado
var MAX_QTY = 5;

/* Cores das capas e a foto de cada uma */
var COLOR_OPTIONS = [
  { id: "cinza", label: "Cinza", image: "assets/galeria/PAGA_1_55_600x.webp" },
  { id: "vermelho", label: "Vermelho", image: "assets/galeria/PAGA_1_54_600x.webp" },
  { id: "marrom", label: "Marrom", image: "assets/galeria/PAGA_1_56_600x.webp" }
];

/* Mesmos textos das políticas da loja */
var SHIPPING_TEXT = "Frete grátis para todo o Brasil";
var SHIPPING_DETAIL = "entrega estimada de 3 a 5 dias";
var RETURNS_TEXT = "Devolução grátis em até 7 dias";
var WARRANTY_TEXT = "Garantia de 30 dias";
var SUPPORT_EMAIL = "suporte@pontodelas.com";
