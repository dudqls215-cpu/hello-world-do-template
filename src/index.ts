// @ts-nocheck
// 픽셀 RPG 방 서버 v6 — Cloudflare Workers + Durable Objects (무료 플랜)
// 훈련장 방 하나가 Durable Object 하나다. 접속한 사람이 보낸 "내 상태"(위치·방향·직업·동작)를 같은 방의 다른 사람에게 전달만 한다.
// 상태 말고 "작은 사건"(예: 적이 공격을 시작함, 허수아비가 맞음)도 전달한다: 이름 하나 + 숫자 몇 개. 무슨 뜻인지는 게임이 정하고, 서버는 모양만 검사한다.
// (v4) 닉네임: 방 안에서 "내 이름과 번호"를 알리면 기억했다가 새로 온 사람에게도 알려 준다.
// (v4) 로비: 방과 따로, 모든 사람이 한 곳(lobby)에 접속해 "나는 누구이고 어디 있다"를 알린다. 친구가 지금 접속해 있는지, 어디 있는지 묻고,
//      번호를 아는 사람에게 짧은 쪽지(친구 신청·파티 신청·파티 체력)를 보낸다. 로비도 같은 Durable Object 종류를 쓰므로 Cloudflare 설정은 그대로다.
// (v5) 유령 정리: 앱을 갑자기 끄면 연결이 끊긴 것을 서버가 모를 수 있다. 접속마다 '마지막으로 소식이 온 때'를 기억하고(메시지 + 자동 응답한 "p"),
//      방은 30초·로비는 70초 동안 소식이 없는 연결을 닫고 방 사람들에게 나갔다고 알린다. 새 사람이 들어올 때와 메시지가 올 때(5초에 한 번) 확인한다.
// (v6) 채팅: { t: "c", s: 글 } — 40자까지, 한 사람이 0.8초에 하나. 같은 방 사람들에게 { t: "c", id, s } 로 전달만 한다(기억하지 않는다).
// (v6) 방 위치: 방(Durable Object)은 처음 만들어질 때 자리가 정해지고 옮겨지지 않는다. https://<서버 주소>/where 를 열면 방이 있는 데이터센터(colo)가 보인다.
// (v6.1) 'apac'로 지정했더니 싱가포르(SIN)에 생겼다. 지정을 빼고 이름을 "v7-"로 바꿔 다시 만든다: 지정이 없으면 방은 처음 부른 곳 근처에 생긴다.
//      서버를 올린 뒤 한국에서 https://<서버 주소>/where?all 을 열면 방 1~9와 로비를 모두 한국 근처에 만들고 위치를 보여 준다.
// 주소: wss://<서버 주소>/ws/train-1 … train-9 · wss://<서버 주소>/ws/lobby   ·   https://<서버 주소>/ 를 열면 "ok" 가 보인다.
import { DurableObject } from "cloudflare:workers";

const CAP = 12; // 방 하나에 들어갈 수 있는 사람 수. 꽉 차면 닫힘 코드 4001 로 돌려보내고, 게임이 다음 방을 찾는다
const LOBBY_CAP = 400; // 로비에 동시에 접속할 수 있는 사람 수
const MAX_LEN = 160; // 받는 메시지의 최대 길이(글자)
const STALE = 30000; // (v5) 방: 이만큼(ms) 소식이 없으면 유령으로 보고 닫는다 (게임은 6초마다 상태를 다시 보낸다)
const LOBBY_STALE = 70000; // (v5) 로비: 게임이 25초마다 "p" 를 보낸다
const MAX_RATE = 30; // 한 사람이 1초에 보낼 수 있는 메시지 수. 넘는 것은 버린다
const CHAT_MAX = 40; // (v6) 채팅 글자 수
const CHAT_GAP = 800; // (v6) 한 사람의 채팅 사이 최소 간격(ms)
const ROOMS = "v7-"; // (v6.1) 방 이름 앞에 붙는 말: 바꾸면 방이 새로 만들어진다 (v6-: 싱가포르에 생김)
const CLASS = /^[a-z]{2}$/; // 직업 이름은 영문 소문자 두 글자면 받는다. 어떤 직업이 있는지는 게임이 안다 — 직업이 늘어도 서버를 바꿀 필요가 없다
const CODE = /^[a-z0-9]{8}$/; // (v4) 사람 번호: 게임이 기기마다 한 번 만든 영문 소문자·숫자 8자
const NAME = /^[가-힣a-zA-Z0-9]{1,12}$/; // (v4) 닉네임: 한글·영문·숫자 12자까지
const WHERE = /^[a-z]{1,8}-[1-9]$/; // (v4) 어디 있는지: 장소 이름-방 번호 (예: lab-3)
const NOTE = /^[a-z0-9,]{0,60}$/; // (v4) 쪽지에 붙는 짧은 글(파티원 번호 목록 등)

// 받은 상태를 검사해서 깨끗한 값만 남긴다. 이상하면 null (전달하지 않음)
function clean(m) {
	if (!m || typeof m !== "object" || m.t !== "s") return null;
	const x = Number(m.x), q = Number(m.q);
	if (!Number.isFinite(x) || !Number.isFinite(q)) return null;
	if (typeof m.c !== "string" || !CLASS.test(m.c)) return null;
	if (typeof m.a !== "string" || !/^[a-z0-9]{1,12}$/.test(m.a)) return null;
	return { x: Math.round(Math.max(0, Math.min(640, x)) * 10) / 10, f: m.f < 0 ? -1 : 1, c: m.c, a: m.a, q: Math.max(0, Math.min(65535, Math.floor(q))), g: m.g ? 1 : 0 };
}

// 숫자 목록: 6개 이하, 각각 ±100000 안, 소수 한 자리. 이상하면 null
function nums(v) {
	if (!Array.isArray(v) || v.length > 6) return null;
	const out = [];
	for (const n of v) {
		if (typeof n !== "number" || !Number.isFinite(n)) return null;
		out.push(Math.round(Math.max(-100000, Math.min(100000, n)) * 10) / 10);
	}
	return out;
}

// 작은 사건: { t: "e", k: 이름(영문 소문자 1~6자), v: 숫자 6개 이하 }. 이상하면 null (전달하지 않음)
function cleanEvent(m) {
	if (!m || typeof m !== "object" || m.t !== "e") return null;
	if (typeof m.k !== "string" || !/^[a-z]{1,6}$/.test(m.k)) return null;
	const v = nums(m.v);
	return v ? { k: m.k, v } : null;
}

// (v6) 채팅: 글자만 남기고(제어 문자 없앰, 공백 하나로) 1~40자면 그 글, 아니면 null
function cleanChat(m) {
	if (!m || typeof m !== "object" || m.t !== "c" || typeof m.s !== "string") return null;
	const s = m.s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").replace(/\s+/g, " ").trim();
	const n = [...s].length;
	return n >= 1 && n <= CHAT_MAX ? s : null;
}

// (v4) 방 안에서 내 이름: { t: "n", u: 번호, n: 닉네임 }. 이상하면 null
function cleanName(m) {
	if (!m || typeof m !== "object" || m.t !== "n") return null;
	if (typeof m.u !== "string" || !CODE.test(m.u) || typeof m.n !== "string" || !NAME.test(m.n)) return null;
	return { u: m.u, n: m.n };
}

export class MyDurableObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		// 살아 있는지 묻는 "p" 에는 방을 깨우지 않고 "o" 로 답하게 한다. 이 기능이 없는 환경이면 아래 webSocketMessage 가 직접 답한다
		try {
			this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "o"));
		} catch (e) {
			// not available here: answered by hand below
		}
	}

	// 새 접속. 방이 차 있으면 4001 로 닫는다. 아니면 번호를 주고, 지금 방에 있는 사람들의 마지막 상태(와 이름)를 알려 준다
	async fetch(request) {
		if (new URL(request.url).pathname === "/where") { // (v6) 이 방이 있는 데이터센터
			let colo = "?";
			try {
				const t = await (await fetch("https://cloudflare.com/cdn-cgi/trace")).text();
				colo = (/colo=([A-Z]+)/.exec(t) || [])[1] || "?";
			} catch (e) {
				// no way out from here
			}
			return new Response("room colo=" + colo, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		const lobby = new URL(request.url).pathname === "/ws/lobby";
		const pair = new WebSocketPair();
		const client = pair[0], server = pair[1];
		this.sweep(true); // (v5) 들어오기 전에 유령부터 정리 — 새 사람이 받는 명단에 유령이 없게
		const here = this.ctx.getWebSockets().filter((o) => !this.gone.has(o));
		if (here.length >= (lobby ? LOBBY_CAP : CAP)) {
			server.accept();
			server.close(4001, "full");
			return new Response(null, { status: 101, webSocket: client });
		}
		this.ctx.acceptWebSocket(server); // 쉬는 동안에는 요금이 붙지 않는 방식(Hibernation)
		const id = 1 + Math.floor(Math.random() * 2147483646);
		server.serializeAttachment({ id, s: null, w: 0, n: 0, lobby, u: null, nm: null, c: null, l: 0, at: null, lt: Date.now() });
		if (lobby) {
			server.send(JSON.stringify({ t: "hi", id, lobby: 1 }));
			return new Response(null, { status: 101, webSocket: client });
		}
		const who = [];
		for (const ws of here) {
			const a = ws.deserializeAttachment();
			if (a && a.s && !a.lobby) who.push(a.u ? [a.id, a.s, a.nm, a.u] : [a.id, a.s]);
		}
		server.send(JSON.stringify({ t: "hi", id, cap: CAP, who, v: 6 }));
		return new Response(null, { status: 101, webSocket: client });
	}

	// 누군가의 상태나 사건이 왔다: 검사하고, (상태는) 기억해 두고, 같은 방의 다른 사람들에게 전달
	async webSocketMessage(ws, message) {
		if (typeof message !== "string" || message.length > MAX_LEN) return;
		const at = ws.deserializeAttachment();
		if (!at) return;
		at.lt = Date.now(); // (v5) 마지막으로 소식이 온 때
		if (message === "p") {
			ws.serializeAttachment(at);
			try {
				ws.send("o");
			} catch (e) {
				// closing
			}
			this.sweep(false);
			return;
		}
		const sec = Math.floor(Date.now() / 1000);
		if (at.w !== sec) {
			at.w = sec;
			at.n = 0;
		}
		at.n++;
		let m = null;
		if (at.n <= MAX_RATE) {
			try {
				m = JSON.parse(message);
			} catch (e) {
				m = null;
			}
		}
		this.sweep(false);
		if (at.lobby) {
			this.lobbyMessage(ws, at, m);
			return;
		}
		const ch = cleanChat(m);
		if (ch) { // (v6) 채팅: 너무 잦으면 버린다
			const now = Date.now();
			if (now - (at.ct || 0) < CHAT_GAP) {
				ws.serializeAttachment(at);
				return;
			}
			at.ct = now;
			ws.serializeAttachment(at);
			this.tell(at.id, JSON.stringify({ t: "c", id: at.id, s: ch }));
			return;
		}
		const s = clean(m), ev = s ? null : cleanEvent(m), nm = s || ev ? null : cleanName(m);
		if (s) at.s = s;
		if (nm) {
			at.u = nm.u;
			at.nm = nm.n;
		}
		ws.serializeAttachment(at);
		if (s) this.tell(at.id, JSON.stringify({ t: "s", id: at.id, x: s.x, f: s.f, c: s.c, a: s.a, q: s.q, g: s.g }));
		else if (ev) this.tell(at.id, JSON.stringify({ t: "e", id: at.id, k: ev.k, v: ev.v })); // 사건은 기억하지 않고 전달만 한다
		else if (nm) this.tell(at.id, JSON.stringify({ t: "n", id: at.id, u: nm.u, n: nm.n }));
	}

	// (v4) 로비에 온 메시지
	//   { t: "me", u, n, c, l, w }  나는 누구(번호·닉네임·직업·레벨)이고 어디(장소-방) 있다 — 기억해 둔다
	//   { t: "q", l: [번호…] }       이 사람들 지금 접속해 있나? → { t: "qa", l: [[번호, 닉네임, 직업, 레벨, 장소]…] } (접속한 사람만)
	//   { t: "d", to, k, v, s }      번호 to 인 사람에게 쪽지 → 그 사람에게 { t: "d", from, n, c, l, w, k, v, s }. 없으면 나에게 { t: "nf", to, k }
	lobbyMessage(ws, at, m) {
		if (!m || typeof m !== "object") return;
		if (m.t === "me") {
			if (typeof m.u !== "string" || !CODE.test(m.u) || typeof m.n !== "string" || !NAME.test(m.n)) return;
			if (typeof m.c !== "string" || !CLASS.test(m.c) || typeof m.w !== "string" || !WHERE.test(m.w)) return;
			at.u = m.u;
			at.nm = m.n;
			at.c = m.c;
			at.l = Math.max(1, Math.min(99, Math.floor(Number(m.l)) || 1));
			at.at = m.w;
			ws.serializeAttachment(at);
			return;
		}
		ws.serializeAttachment(at);
		if (!at.u) return; // 자기소개 전에는 묻거나 쪽지를 보낼 수 없다
		if (m.t === "q") {
			if (!Array.isArray(m.l) || m.l.length > 12) return;
			const want = new Set(m.l.filter((u) => typeof u === "string" && CODE.test(u)));
			const seen = new Map();
			for (const o of this.ctx.getWebSockets()) {
				const a = o.deserializeAttachment();
				if (a && a.u && want.has(a.u)) seen.set(a.u, [a.u, a.nm, a.c, a.l, a.at]);
			}
			try {
				ws.send(JSON.stringify({ t: "qa", l: [...seen.values()] }));
			} catch (e) {
				// closing
			}
			return;
		}
		if (m.t === "d") {
			if (typeof m.to !== "string" || !CODE.test(m.to) || m.to === at.u) return;
			if (typeof m.k !== "string" || !/^[a-z]{1,6}$/.test(m.k)) return;
			const v = nums(m.v === undefined ? [] : m.v);
			const s = m.s === undefined ? "" : m.s;
			if (!v || typeof s !== "string" || !NOTE.test(s)) return;
			const text = JSON.stringify({ t: "d", from: at.u, n: at.nm, c: at.c, l: at.l, w: at.at, k: m.k, v, s });
			let sent = 0;
			for (const o of this.ctx.getWebSockets()) {
				const a = o.deserializeAttachment();
				if (!a || a.u !== m.to || o === ws) continue;
				try {
					o.send(text);
					sent++;
				} catch (e) {
					// that connection is closing
				}
			}
			if (!sent) {
				try {
					ws.send(JSON.stringify({ t: "nf", to: m.to, k: m.k }));
				} catch (e) {
					// closing
				}
			}
		}
	}

	async webSocketClose(ws, code, reason, wasClean) {
		this.left(ws);
		try {
			if (code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code)) ws.close(code, reason);
			else ws.close();
		} catch (e) {
			// already closed
		}
	}

	async webSocketError(ws, error) {
		this.left(ws);
	}

	// (v5) 소식이 끊긴 연결(유령)을 닫고 나갔다고 알린다. now: 새 사람이 들어올 때는 바로, 메시지가 올 때는 5초에 한 번만
	sweep(now) {
		if (!this.gone) this.gone = new Set();
		const t = Date.now();
		if (!now && this.swept && t - this.swept < 5000) return;
		this.swept = t;
		for (const o of this.ctx.getWebSockets()) {
			if (this.gone.has(o)) continue;
			const a = o.deserializeAttachment();
			if (!a) continue;
			let last = a.lt || 0;
			try {
				const r = this.ctx.getWebSocketAutoResponseTimestamp(o); // 방을 깨우지 않고 답한 "p" 의 시각
				if (r) last = Math.max(last, r.getTime());
			} catch (e) {
				// not available here
			}
			if (last && t - last > (a.lobby ? LOBBY_STALE : STALE)) {
				this.gone.add(o);
				try {
					o.close(4002, "stale");
				} catch (e) {
					// already closed
				}
				this.left(o);
			}
		}
	}

	// 나간 사람을 다른 사람들에게 알린다 (로비는 알리지 않는다 — 친구 목록은 물어볼 때 다시 확인한다)
	left(ws) {
		const at = ws.deserializeAttachment();
		if (at && !at.lobby) this.tell(at.id, JSON.stringify({ t: "bye", id: at.id }));
	}

	// 보낸 사람(번호 from)을 뺀 방 안의 모두에게 보낸다
	tell(from, text) {
		for (const o of this.ctx.getWebSockets()) {
			if (this.gone && this.gone.has(o)) continue;
			const a = o.deserializeAttachment();
			if (!a || a.id === from) continue;
			try {
				o.send(text);
			} catch (e) {
				// that connection is closing
			}
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const ns = Object.values(env).find((v) => v && typeof v.idFromName === "function"); // the Durable Object binding, whatever it is called
		if (url.pathname === "/where" && ns) { // (v6.1) 방 1이 어디 있나 (?all: 방 1~9와 로비를 모두 — 없으면 여기 근처에 만든다)
			const names = url.searchParams.has("all") ? ["train-1", "train-2", "train-3", "train-4", "train-5", "train-6", "train-7", "train-8", "train-9", "lobby"] : ["train-1"];
			const out = [];
			for (const n of names) {
				try {
					out.push(n + ": " + (await (await ns.get(ns.idFromName(ROOMS + n)).fetch(new Request("https://room/where"))).text()));
				} catch (e) {
					out.push(n + ": ?");
				}
			}
			return new Response(out.join("\n") + "\n(v6.1 · 이 요청이 들어온 곳 " + ((request.cf && request.cf.colo) || "?") + ")", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		const m = /^\/ws\/(train-[1-9]|lobby)$/.exec(url.pathname);
		if (!m) return new Response("pixel rpg room server: ok (v6.1) · edge " + ((request.cf && request.cf.colo) || "?"), { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
		if (!ns) return new Response("no durable object binding", { status: 500 });
		return ns.get(ns.idFromName(ROOMS + m[1])).fetch(request); // (v6.1) 새 이름의 방: 처음 부른 곳 근처에 생긴다
	},
};
