// @ts-nocheck
// 픽셀 RPG 방 서버 — Cloudflare Workers + Durable Objects (무료 플랜)
// 훈련장 방 하나가 Durable Object 하나다. 접속한 사람이 보낸 "내 상태"(위치·방향·직업·동작)를 같은 방의 다른 사람에게 전달만 한다.
// 상태 말고 "작은 사건"(예: 적이 공격을 시작함, 허수아비가 맞음)도 전달한다: 이름 하나 + 숫자 몇 개. 무슨 뜻인지는 게임이 정하고, 서버는 모양만 검사한다.
// 주소: wss://<서버 주소>/ws/train-1 … train-9   ·   https://<서버 주소>/ 를 열면 "ok" 가 보인다.
import { DurableObject } from "cloudflare:workers";

const CAP = 12; // 방 하나에 들어갈 수 있는 사람 수. 꽉 차면 닫힘 코드 4001 로 돌려보내고, 게임이 다음 방을 찾는다
const MAX_LEN = 160; // 받는 메시지의 최대 길이(글자)
const MAX_RATE = 30; // 한 사람이 1초에 보낼 수 있는 메시지 수. 넘는 것은 버린다
const CLASSES = ["gs", "sw", "sm", "en", "ar", "gn"];

// 받은 상태를 검사해서 깨끗한 값만 남긴다. 이상하면 null (전달하지 않음)
function clean(m) {
	if (!m || typeof m !== "object" || m.t !== "s") return null;
	const x = Number(m.x), q = Number(m.q);
	if (!Number.isFinite(x) || !Number.isFinite(q)) return null;
	if (!CLASSES.includes(m.c)) return null;
	if (typeof m.a !== "string" || !/^[a-z0-9]{1,12}$/.test(m.a)) return null;
	return { x: Math.round(Math.max(0, Math.min(640, x)) * 10) / 10, f: m.f < 0 ? -1 : 1, c: m.c, a: m.a, q: Math.max(0, Math.min(65535, Math.floor(q))), g: m.g ? 1 : 0 };
}

// 작은 사건: { t: "e", k: 이름(영문 소문자 1~6자), v: 숫자 6개 이하 }. 이상하면 null (전달하지 않음)
function cleanEvent(m) {
	if (!m || typeof m !== "object" || m.t !== "e") return null;
	if (typeof m.k !== "string" || !/^[a-z]{1,6}$/.test(m.k)) return null;
	if (!Array.isArray(m.v) || m.v.length > 6) return null;
	const v = [];
	for (const n of m.v) {
		if (typeof n !== "number" || !Number.isFinite(n)) return null;
		v.push(Math.round(Math.max(-100000, Math.min(100000, n)) * 10) / 10);
	}
	return { k: m.k, v };
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

	// 새 접속. 방이 차 있으면 4001 로 닫는다. 아니면 번호를 주고, 지금 방에 있는 사람들의 마지막 상태를 알려 준다
	async fetch(request) {
		const pair = new WebSocketPair();
		const client = pair[0], server = pair[1];
		const here = this.ctx.getWebSockets();
		if (here.length >= CAP) {
			server.accept();
			server.close(4001, "full");
			return new Response(null, { status: 101, webSocket: client });
		}
		this.ctx.acceptWebSocket(server); // 쉬는 동안에는 요금이 붙지 않는 방식(Hibernation)
		const id = 1 + Math.floor(Math.random() * 2147483646);
		server.serializeAttachment({ id, s: null, w: 0, n: 0 });
		const who = [];
		for (const ws of here) {
			const a = ws.deserializeAttachment();
			if (a && a.s) who.push([a.id, a.s]);
		}
		server.send(JSON.stringify({ t: "hi", id, cap: CAP, who }));
		return new Response(null, { status: 101, webSocket: client });
	}

	// 누군가의 상태나 사건이 왔다: 검사하고, (상태는) 기억해 두고, 같은 방의 다른 사람들에게 전달
	async webSocketMessage(ws, message) {
		if (typeof message !== "string" || message.length > MAX_LEN) return;
		if (message === "p") {
			try {
				ws.send("o");
			} catch (e) {
				// closing
			}
			return;
		}
		const at = ws.deserializeAttachment();
		if (!at) return;
		const sec = Math.floor(Date.now() / 1000);
		if (at.w !== sec) {
			at.w = sec;
			at.n = 0;
		}
		at.n++;
		let s = null, ev = null;
		if (at.n <= MAX_RATE) {
			try {
				const m = JSON.parse(message);
				s = clean(m);
				if (!s) ev = cleanEvent(m);
			} catch (e) {
				s = null;
				ev = null;
			}
		}
		if (s) at.s = s;
		ws.serializeAttachment(at);
		if (s) this.tell(at.id, JSON.stringify({ t: "s", id: at.id, x: s.x, f: s.f, c: s.c, a: s.a, q: s.q, g: s.g }));
		else if (ev) this.tell(at.id, JSON.stringify({ t: "e", id: at.id, k: ev.k, v: ev.v })); // 사건은 기억하지 않고 전달만 한다
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

	// 나간 사람을 다른 사람들에게 알린다
	left(ws) {
		const at = ws.deserializeAttachment();
		if (at) this.tell(at.id, JSON.stringify({ t: "bye", id: at.id }));
	}

	// 보낸 사람(번호 from)을 뺀 방 안의 모두에게 보낸다
	tell(from, text) {
		for (const o of this.ctx.getWebSockets()) {
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
		const m = /^\/ws\/train-([1-9])$/.exec(url.pathname);
		if (!m) return new Response("pixel rpg room server: ok (v2)", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
		const ns = Object.values(env).find((v) => v && typeof v.idFromName === "function"); // the Durable Object binding, whatever it is called
		if (!ns) return new Response("no durable object binding", { status: 500 });
		return ns.get(ns.idFromName("train-" + m[1])).fetch(request);
	},
};
