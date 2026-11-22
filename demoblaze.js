// Práctica 4 - K6 Studio: Demoblaze (limpio, parametrizado y correlacionado)
// Flujo: home -> login -> categoría -> producto -> carrito
//
// Parametrización: usuarios.csv (usuario, contraseña, categoría)
// Correlación:     1) token del login  -> /check, /addtocart, /viewcart, /deletecart
//                  2) id de producto de /bycat -> /view, /addtocart

import { group, sleep, check } from "k6";
import http from "k6/http";
import execution from "k6/execution";
import encoding from "k6/encoding";
import { SharedArray } from "k6/data";
import { uuidv4, randomItem } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import papaparse from "https://jslib.k6.io/papaparse/5.1.1/index.js";

export const options = {
  stages: [
    { target: 5, duration: "10s" },
    { target: 5, duration: "30s" },
    { target: 0, duration: "5s" },
  ],
  thresholds: {
    http_req_duration: ["p(95)<1200", "p(99)<1500"],
    http_req_failed: [{ threshold: "rate<0.01" }],
  },
};

const SITE = "https://www.demoblaze.com";
const API = "https://api.demoblaze.com";

// ---------- PARAMETRIZACIÓN ----------
const users = new SharedArray("users", () => {
  const parsed = papaparse.parse(open("./usuarios.csv"), {
    header: true,
    delimiter: ";",
    skipEmptyLines: true,
  });
  if (parsed.errors.length > 0) {
    throw new Error(`Error leyendo CSV: ${parsed.errors.map((e) => e.message).join(", ")}`);
  }
  return parsed.data;
});

if (users.length === 0) {
  throw new Error("usuarios.csv está vacío.");
}

const jsonParams = {
  headers: {
    "content-type": "application/json",
    origin: SITE,
    referer: `${SITE}/`,
  },
};

// Registra los usuarios del CSV una sola vez (si ya existen, el sitio lo ignora)
export function setup() {
  users.forEach((u) => {
    http.post(
      `${API}/signup`,
      JSON.stringify({
        username: u.username,
        password: encoding.b64encode(u.password),
      }),
      jsonParams
    );
  });
}

export default function () {
  const user = users[execution.scenario.iterationInTest % users.length];
  let resp;

  // ---------- 1. HOME ----------
  group("01_home", function () {
    resp = http.get(`${SITE}/`, {
      headers: { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
    });
    check(resp, { "home 200": (r) => r.status === 200 });

    resp = http.get(`${API}/entries`, jsonParams);
    check(resp, { "entries 200": (r) => r.status === 200 });
  });

  // ---------- 2. LOGIN (correlación del token) ----------
  let token = "";
  group("02_login", function () {
    resp = http.post(
      `${API}/login`,
      JSON.stringify({
        username: user.username,
        password: encoding.b64encode(user.password),
      }),
      jsonParams
    );
    check(resp, { "login 200": (r) => r.status === 200 });

    // La respuesta es del estilo "Auth_token: xxxx"
    token = String(resp.body).replace(/"/g, "").replace("Auth_token:", "").trim();
    check(token, { "token extraído": (t) => t.length > 0 });

    resp = http.post(`${API}/check`, JSON.stringify({ token: token }), jsonParams);
    check(resp, { "check 200": (r) => r.status === 200 });
  });

  // ---------- 3. CATEGORÍA (correlación del id de producto) ----------
  let product = null;
  group("03_categoria", function () {
    resp = http.post(`${API}/bycat`, JSON.stringify({ cat: user.categoria }), jsonParams);
    check(resp, { "bycat 200": (r) => r.status === 200 });

    let items = [];
    try {
      items = resp.json("Items") || [];
    } catch (e) {
      items = [];
    }
    check(items, { "hay productos": (i) => i.length > 0 });

    // Se elige un producto al azar de la respuesta (no un id fijo)
    product = items.length > 0 ? randomItem(items) : null;
  });

  if (!product) {
    sleep(1);
    return; // sin producto no se puede continuar el flujo
  }

  // ---------- 4. PRODUCTO ----------
  group("04_producto", function () {
    resp = http.post(`${API}/view`, JSON.stringify({ id: String(product.id) }), jsonParams);
    check(resp, {
      "view 200": (r) => r.status === 200,
      "producto correcto": (r) => {
        try {
          return r.json("id") === product.id;
        } catch (e) {
          return false;
        }
      },
    });
  });

  // ---------- 5. CARRITO ----------
  group("05_carrito", function () {
    resp = http.post(
      `${API}/addtocart`,
      JSON.stringify({
        id: uuidv4(),
        cookie: token,
        prod_id: product.id,
        flag: false,
      }),
      jsonParams
    );
    check(resp, { "addtocart 200": (r) => r.status === 200 });

    resp = http.post(`${API}/viewcart`, JSON.stringify({ cookie: token, flag: false }), jsonParams);
    check(resp, {
      "viewcart 200": (r) => r.status === 200,
      "carrito con productos": (r) => {
        try {
          return (r.json("Items") || []).length > 0;
        } catch (e) {
          return false;
        }
      },
    });

    // Vacía el carrito para que no crezca en cada iteración
    resp = http.post(`${API}/deletecart`, JSON.stringify({ cookie: token }), jsonParams);
    check(resp, { "deletecart 200": (r) => r.status === 200 });
  });

  sleep(1);
}
