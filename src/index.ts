// @ts-nocheck
// 픽셀 RPG 방 서버 v10 — Cloudflare Workers + Durable Objects (무료 플랜)
// (v10) 관리자: https://<서버 주소>/admin 을 열면 관리자 화면. 관리자 키(Cloudflare 비밀 값 ADMIN_KEY)를 넣고
//      · 아이디 목록 보기 (아이디 · 마지막 저장 시각 · 로그인된 기기 수)
//      · 임시 비밀번호 발급 — 비밀번호를 잊은 플레이어용. 그 계정에 로그인돼 있던 기기는 모두 로그아웃되고, 캐릭터 저장은 그대로 남는다.
//      관리자 키를 5번 틀리면 관리자 기능 전체가 10분 쉰다. ADMIN_KEY 가 없거나 12자보다 짧으면 관리자 기능은 꺼져 있다.
//      게임이 읽는 버전 표시(첫 화면의 "(v9)", 접속 인사말의 v: 9)는 그대로 둔다 — 게임은 바뀐 것이 없다.
// (v9) 계정: POST https://<서버 주소>/acct/signup · login · load · save · logout (본문은 JSON 글). 아이디(영문 소문자·숫자 4~12자)와 비밀번호(4~32자).
//      비밀번호는 저장하지 않는다 — 소금(salt)을 섞어 여러 번 해시한 값만 둔다. 로그인하면 열쇠(tok)를 주고, 그 뒤로는 열쇠로 저장을 읽고 쓴다(기기 5대까지).
//      저장은 글 한 덩어리(6만 자까지)와 판 번호(rev). 내가 아는 판 번호가 서버와 다르면(다른 기기가 먼저 저장) 덮어쓰지 않고 서버의 것을 돌려준다.
//      계정은 방과 다른 Durable Object(acct-<아이디 첫 글자>)의 저장소에 둔다 — 방 이름(ROOMS)을 바꿔도 계정은 남는다.
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
// (v6.2) 지정 없이도 싱가포르였다. 2026년 6월에 생긴 'apac-ne'(동북아시아) 지정으로 "v8-" 방을 새로 만든다.
// (v8) 레이드 대기실: 준비 { t: "rr", v } · 방 사람들 { t: "rm" } → { t: "rm", id, b, l: [[코드, 이름, 직업, 레벨, 준비, 방장]] } · 출발 { t: "rs" } → 모두에게 { t: "rg", id, b } · 못 들어감 { t: "rf" }. 방 10개(train-10: 3층).
// (v7) 보스 레이드 방: wss://<서버 주소>/ws/raid-<번호> 는 누구나 만들 수 있는 4인 방. 로비가 열린 레이드 방 목록을 알려 준다
//      (방장: { t: "rc", id, b } · 참여: { t: "rj", id } · 나감: { t: "rx" } · 목록: { t: "rl", b } → { t: "rl", b, l: [[id, 방장 이름, 인원]] }).
//      작은 일(e)에 붙는 숫자를 6개에서 12개까지로 늘림.
// (v6.3) 상태 메시지에 높이 y(0~400)를 같이 전한다: 8방향 대쉬로 공중에 떠 있는 모습이 다른 사람 화면에도 보이게.
// 주소: wss://<서버 주소>/ws/train-1 … train-9 · wss://<서버 주소>/ws/lobby   ·   https://<서버 주소>/ 를 열면 "ok" 가 보인다.
import { DurableObject } from "cloudflare:workers";

const RAID_CAP = 4; // (v7) 보스 레이드 방의 인원
const RAID = /^[a-z0-9]{4,8}$/; // (v7) 레이드 방 번호
const CAP = 12; // 방 하나에 들어갈 수 있는 사람 수. 꽉 차면 닫힘 코드 4001 로 돌려보내고, 게임이 다음 방을 찾는다
const LOBBY_CAP = 400; // 로비에 동시에 접속할 수 있는 사람 수
const MAX_LEN = 160; // 받는 메시지의 최대 길이(글자)
const STALE = 30000; // (v5) 방: 이만큼(ms) 소식이 없으면 유령으로 보고 닫는다 (게임은 6초마다 상태를 다시 보낸다)
const LOBBY_STALE = 70000; // (v5) 로비: 게임이 25초마다 "p" 를 보낸다
const MAX_RATE = 30; // 한 사람이 1초에 보낼 수 있는 메시지 수. 넘는 것은 버린다
const CHAT_MAX = 40; // (v6) 채팅 글자 수
const CHAT_GAP = 800; // (v6) 한 사람의 채팅 사이 최소 간격(ms)
const ROOMS = "v8-"; // (v6.2) 방 이름 앞에 붙는 말: 바꾸면 방이 새로 만들어진다 (v6-: apac 지정 → 싱가포르, v7-: 지정 없이 → 역시 싱가포르)
const PLACE = "apac-ne"; // (v6.2) 새 방을 둘 곳: 동북아시아(일본·한국). 2026년 6월에 생긴 좁은 지정 — 최선을 다할 뿐 보장은 아니다
const CLASS = /^[a-z]{2}$/; // 직업 이름은 영문 소문자 두 글자면 받는다. 어떤 직업이 있는지는 게임이 안다 — 직업이 늘어도 서버를 바꿀 필요가 없다
const CODE = /^[a-z0-9]{8}$/; // (v4) 사람 번호: 게임이 기기마다 한 번 만든 영문 소문자·숫자 8자
const NAME = /^[가-힣a-zA-Z0-9]{1,12}$/; // (v4) 닉네임: 한글·영문·숫자 12자까지
const WHERE = /^[a-z]{1,8}-[1-9]$/; // (v4) 어디 있는지: 장소 이름-방 번호 (예: lab-3)
const ACCT_ID = /^[a-z0-9]{4,12}$/; // (v9) 계정 아이디
const ACCT_MAX = 60000; // (v9) 저장 한 덩어리의 최대 길이(글자)
const ADMIN_FAILS = 5; // (v10) 관리자 키를 이만큼 틀리면
const ADMIN_LOCK = 600000; // (v10) 이만큼(ms) 관리자 기능을 쉰다
const TEMP_CH = "abcdefghjkmnpqrstuvwxyz23456789"; // (v10) 임시 비밀번호 글자 (헷갈리는 i l o 0 1 뺌)
const ACCT_ITER = 2000; // (v9) 비밀번호 해시 반복 수 (무료 플랜의 요청당 계산 시간 안에서)
const CORS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store" };
const J = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: CORS });
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const rand = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function sha(t) {
	return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
}
async function pwHash(pw, salt) {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
	return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: ACCT_ITER }, key, 256));
}
// (v10) 임시 비밀번호 8자
function tempPw() {
	let out = "";
	while (out.length < 8) {
		for (const b of crypto.getRandomValues(new Uint8Array(16))) {
			if (b < 248 && out.length < 8) out += TEMP_CH[b % TEMP_CH.length]; // 248 = 31×8: 고르게 나오게
		}
	}
	return out;
}
const NOTE = /^[a-z0-9,]{0,60}$/; // (v4) 쪽지에 붙는 짧은 글(파티원 번호 목록 등)

// 받은 상태를 검사해서 깨끗한 값만 남긴다. 이상하면 null (전달하지 않음)
function clean(m) {
	if (!m || typeof m !== "object" || m.t !== "s") return null;
	const x = Number(m.x), q = Number(m.q);
	if (!Number.isFinite(x) || !Number.isFinite(q)) return null;
	if (typeof m.c !== "string" || !CLASS.test(m.c)) return null;
	if (typeof m.a !== "string" || !/^[a-z0-9]{1,12}$/.test(m.a)) return null;
	const o = { x: Math.round(Math.max(0, Math.min(640, x)) * 10) / 10, f: m.f < 0 ? -1 : 1, c: m.c, a: m.a, q: Math.max(0, Math.min(65535, Math.floor(q))), g: m.g ? 1 : 0 };
	const y = Number(m.y); // (v6.3) 높이: 공중 대쉬(위·아래·대각선)를 다른 사람 화면에도
	if (m.y !== undefined && Number.isFinite(y)) o.y = Math.round(Math.max(0, Math.min(400, y)));
	return o;
}

// 숫자 목록: 6개 이하, 각각 ±100000 안, 소수 한 자리. 이상하면 null
function nums(v) {
	if (!Array.isArray(v) || v.length > 12) return null;
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

	// (v10) 관리자 — 바깥에서는 부를 수 없고, 아래 export default 가 키를 확인한 뒤에만 부른다
	//   /admin-gate  (관리자 문지기 방) 키 확인 + 틀린 횟수 세기
	//   /admin-list  (계정 방) 이 방에 있는 아이디들
	//   /admin-reset (계정 방) 임시 비밀번호로 바꾸고 로그인된 기기 모두 로그아웃
	async admin(request, path) {
		let m = null;
		try {
			m = JSON.parse(await request.text());
		} catch (e) {
			m = null;
		}
		if (!m || typeof m !== "object") return J({ ok: 0, e: "bad" });
		const st = this.ctx.storage, now = Date.now();
		if (path === "/admin-gate") {
			const want = this.env && typeof this.env.ADMIN_KEY === "string" ? this.env.ADMIN_KEY : "";
			if (want.length < 12) return J({ ok: 0, e: "off" });
			const g = (await st.get("gate")) || { fail: 0, lock: 0 };
			if (g.lock > now) return J({ ok: 0, e: "wait", s: Math.ceil((g.lock - now) / 1000) });
			if (typeof m.key !== "string" || m.key.length > 200 || (await sha(m.key)) !== (await sha(want))) {
				g.fail = (g.fail || 0) + 1;
				if (g.fail >= ADMIN_FAILS) {
					g.fail = 0;
					g.lock = now + ADMIN_LOCK;
				}
				await st.put("gate", g);
				return J({ ok: 0, e: "key", left: g.lock > now ? 0 : ADMIN_FAILS - g.fail });
			}
			if (g.fail) await st.put("gate", { fail: 0, lock: 0 });
			return J({ ok: 1 });
		}
		if (path === "/admin-list") {
			const l = [];
			for (const [k, u] of await st.list({ prefix: "u:", limit: 1000 })) l.push([k.slice(2), u.at || 0, (u.toks || []).length]);
			return J({ ok: 1, l });
		}
		if (path === "/admin-reset") {
			if (typeof m.id !== "string" || !ACCT_ID.test(m.id)) return J({ ok: 0, e: "id" });
			const key = "u:" + m.id, u = await st.get(key);
			if (!u) return J({ ok: 0, e: "none" });
			const pw = tempPw();
			u.salt = rand(16);
			u.h = await pwHash(pw, u.salt);
			u.toks = []; // 로그인돼 있던 기기 모두 로그아웃 (그 기기의 저장은 'auth' 로 거절된다)
			u.fail = 0;
			u.lock = 0;
			await st.put(key, u);
			return J({ ok: 1, pw, at: u.at || 0 });
		}
		return J({ ok: 0, e: "bad" });
	}

	// 새 접속. 방이 차 있으면 4001 로 닫는다. 아니면 번호를 주고, 지금 방에 있는 사람들의 마지막 상태(와 이름)를 알려 준다
	// (v9) 계정: 만들기 · 로그인 · 읽기 · 저장 · 로그아웃
	async acct(request, path) {
		let m = null;
		try {
			m = JSON.parse((await request.text()).slice(0, ACCT_MAX + 2000));
		} catch (e) {
			return J({ ok: 0, e: "bad" });
		}
		if (!m || typeof m !== "object" || typeof m.id !== "string" || !ACCT_ID.test(m.id)) return J({ ok: 0, e: "id" });
		const st = this.ctx.storage, key = "u:" + m.id, now = Date.now();
		let u = await st.get(key);
		if (path === "/acct/signup") {
			if (typeof m.pw !== "string" || m.pw.length < 4 || m.pw.length > 32) return J({ ok: 0, e: "pw" });
			if (u) return J({ ok: 0, e: "taken" });
			const salt = rand(16), tok = rand(24);
			u = { salt, h: await pwHash(m.pw, salt), toks: [await sha(tok)], rev: 0, data: null, at: now, fail: 0, lock: 0 };
			await st.put(key, u);
			return J({ ok: 1, tok, rev: 0, data: null });
		}
		if (path === "/acct/login") {
			if (!u) return J({ ok: 0, e: "wrong" });
			if (u.lock > now) return J({ ok: 0, e: "wait", s: Math.ceil((u.lock - now) / 1000) });
			if (typeof m.pw !== "string" || m.pw.length > 32 || (await pwHash(m.pw, u.salt)) !== u.h) {
				u.fail = (u.fail || 0) + 1;
				if (u.fail >= 5) {
					u.fail = 0;
					u.lock = now + 60000; // 다섯 번 틀리면 1분 쉰다
				}
				await st.put(key, u);
				return J({ ok: 0, e: "wrong" });
			}
			const tok = rand(24);
			u.fail = 0;
			u.toks = [...u.toks, await sha(tok)].slice(-5);
			await st.put(key, u);
			return J({ ok: 1, tok, rev: u.rev, data: u.data });
		}
		if (!u || typeof m.tok !== "string" || !u.toks.includes(await sha(m.tok))) return J({ ok: 0, e: "auth" });
		if (path === "/acct/load") return J({ ok: 1, rev: u.rev, data: u.data });
		if (path === "/acct/save") {
			if (typeof m.data !== "string" || m.data.length > ACCT_MAX) return J({ ok: 0, e: "big" });
			if (u.data !== null && Math.floor(Number(m.rev)) !== u.rev) return J({ ok: 0, e: "conflict", rev: u.rev, data: u.data });
			u.data = m.data;
			u.rev = (u.rev || 0) + 1;
			u.at = now;
			await st.put(key, u);
			return J({ ok: 1, rev: u.rev });
		}
		if (path === "/acct/logout") {
			const h = await sha(m.tok);
			u.toks = u.toks.filter((t) => t !== h);
			await st.put(key, u);
			return J({ ok: 1 });
		}
		return J({ ok: 0, e: "bad" });
	}

	async fetch(request) {
		if (new URL(request.url).pathname.startsWith("/acct/")) return this.acct(request, new URL(request.url).pathname);
		if (new URL(request.url).pathname.startsWith("/admin-")) return this.admin(request, new URL(request.url).pathname); // (v10)
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
		const path = new URL(request.url).pathname, lobby = path === "/ws/lobby", raid = path.startsWith("/ws/raid-");
		const pair = new WebSocketPair();
		const client = pair[0], server = pair[1];
		this.sweep(true); // (v5) 들어오기 전에 유령부터 정리 — 새 사람이 받는 명단에 유령이 없게
		const here = this.ctx.getWebSockets().filter((o) => !this.gone.has(o));
		if (here.length >= (lobby ? LOBBY_CAP : raid ? RAID_CAP : CAP)) {
			server.accept();
			server.close(4001, "full");
			return new Response(null, { status: 101, webSocket: client });
		}
		this.ctx.acceptWebSocket(server); // 쉬는 동안에는 요금이 붙지 않는 방식(Hibernation)
		const id = 1 + Math.floor(Math.random() * 2147483646);
		server.serializeAttachment({ id, s: null, w: 0, n: 0, lobby, u: null, nm: null, c: null, l: 0, at: null, lt: Date.now() });
		if (lobby) {
			server.send(JSON.stringify({ t: "hi", id, lobby: 1, v: 9 }));
			return new Response(null, { status: 101, webSocket: client });
		}
		const who = [];
		for (const ws of here) {
			const a = ws.deserializeAttachment();
			if (a && a.s && !a.lobby) who.push(a.u ? [a.id, a.s, a.nm, a.u] : [a.id, a.s]);
		}
		server.send(JSON.stringify({ t: "hi", id, cap: raid ? RAID_CAP : CAP, who, v: 9 }));
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
		if (s) this.tell(at.id, JSON.stringify({ t: "s", id: at.id, ...s })); // (v6.3) 정리된 그대로(높이 y 포함)
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
		if (m.t === "rc" || m.t === "rj" || m.t === "rx") { // (v7) 레이드 방: 만들기 · 참여 · 나감 · (v8) 가득 찼거나 이미 출발한 방에는 못 들어간다
			at.rd = null;
			if (m.t !== "rx" && typeof m.id === "string" && RAID.test(m.id)) {
				if (m.t === "rc" && (m.b === "boss" || m.b === "boss2")) at.rd = { id: m.id, b: m.b, h: 1, r: 0, s: 0 };
				else {
					let n = 0, started = 0, b = "";
					for (const o of this.ctx.getWebSockets()) {
						if (o === ws || (this.gone && this.gone.has(o))) continue;
						const a = o.deserializeAttachment();
						if (a && a.rd && a.rd.id === m.id) { n++; if (a.rd.s) started = 1; if (a.rd.h) b = a.rd.b; }
					}
					if (m.re !== 1 && (n >= RAID_CAP || started || !b)) { try { ws.send(JSON.stringify({ t: "rf", id: m.id, why: !b ? 2 : started ? 1 : 0 })); } catch (e) { /* closing */ } }
					else at.rd = { id: m.id, h: 0, r: 0, s: m.re === 1 ? 1 : 0 };
				}
			}
			ws.serializeAttachment(at);
			return;
		}
		if (m.t === "rr") { // (v8) 준비 완료 / 취소
			if (at.rd) { at.rd.r = m.v ? 1 : 0; ws.serializeAttachment(at); }
			return;
		}
		if (m.t === "rm" || m.t === "rs") { // (v8) 내 레이드 방의 사람들 · 방장의 출발 신호
			if (!at.rd) return;
			const mem = [];
			for (const o of this.ctx.getWebSockets()) {
				if (this.gone && this.gone.has(o)) continue;
				const a = o === ws ? at : o.deserializeAttachment();
				if (a && a.rd && a.rd.id === at.rd.id) mem.push([o, a]);
			}
			if (m.t === "rs") {
				if (!at.rd.h || mem.some(([, a]) => !a.rd.h && !a.rd.r)) return; // 방장만, 모두 준비했을 때만
				for (const [o, a] of mem) {
					a.rd.s = 1;
					o.serializeAttachment(a);
					try { o.send(JSON.stringify({ t: "rg", id: at.rd.id, b: at.rd.b })); } catch (e) { /* closing */ }
				}
				return;
			}
			const host = mem.find(([, a]) => a.rd.h);
			try { ws.send(JSON.stringify({ t: "rm", id: at.rd.id, b: host ? host[1].rd.b : "", l: mem.slice(0, RAID_CAP + 2).map(([, a]) => [a.u, a.nm, a.c, a.l, a.rd.r ? 1 : 0, a.rd.h ? 1 : 0]) })); } catch (e) { /* closing */ }
			return;
		}
		if (m.t === "rl") { // (v7) 열린 레이드 방 목록 (자리가 남고 아직 출발하지 않은 것만)
			if (m.b !== "boss" && m.b !== "boss2") return;
			const rooms = new Map(), count = new Map(), gone = new Set();
			for (const o of this.ctx.getWebSockets()) {
				if (this.gone && this.gone.has(o)) continue;
				const a = o.deserializeAttachment();
				if (!a || !a.rd) continue;
				count.set(a.rd.id, (count.get(a.rd.id) || 0) + 1);
				if (a.rd.s) gone.add(a.rd.id);
				if (a.rd.h && a.rd.b === m.b) rooms.set(a.rd.id, a.nm);
			}
			const l = [...rooms.entries()].filter(([id]) => !gone.has(id)).map(([id, nm]) => [id, nm, count.get(id) || 1]).filter((r) => r[2] < RAID_CAP).slice(0, 12);
			try {
				ws.send(JSON.stringify({ t: "rl", b: m.b, l }));
			} catch (e) {
				// closing
			}
			return;
		}
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

// (v10) 관리자 화면과 관리자 요청
const ACCT_CH = "abcdefghijklmnopqrstuvwxyz0123456789"; // 계정 방 이름의 끝 글자 (acct-<아이디 첫 글자>)
async function adminRoute(request, url, ns) {
	if (url.pathname === "/admin" && request.method === "GET") return new Response(ADMIN_PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer" } });
	if (request.method !== "POST" || !/^\/admin\/(list|reset)$/.test(url.pathname)) return J({ ok: 0, e: "bad" }, 404);
	if (!ns) return J({ ok: 0, e: "server" }, 500);
	let m = null;
	try {
		m = JSON.parse((await request.text()).slice(0, 1000));
	} catch (e) {
		m = null;
	}
	if (!m || typeof m !== "object" || typeof m.key !== "string") return J({ ok: 0, e: "key" });
	const call = (name, path, body) => ns.get(ns.idFromName(name), { locationHint: PLACE }).fetch(new Request("https://room" + path, { method: "POST", body: JSON.stringify(body) })).then((r) => r.json());
	try {
		const g = await call("admin", "/admin-gate", { key: m.key });
		if (!g.ok) return J(g);
		if (url.pathname === "/admin/reset") {
			if (typeof m.id !== "string" || !ACCT_ID.test(m.id)) return J({ ok: 0, e: "id" });
			return J(await call("acct-" + m.id[0], "/admin-reset", { id: m.id }));
		}
		const parts = await Promise.all([...ACCT_CH].map((c) => call("acct-" + c, "/admin-list", {}).catch(() => ({ ok: 0 }))));
		const l = [];
		let miss = 0;
		for (const r of parts) {
			if (r && r.ok) l.push(...r.l);
			else miss++;
		}
		l.sort((a, b) => (a[0] < b[0] ? -1 : 1));
		return J({ ok: 1, l, miss });
	} catch (e) {
		return J({ ok: 0, e: "server" }, 500);
	}
}

const ADMIN_PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Pixelia 관리자</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#141418;color:#ddd;font:16px/1.5 system-ui,sans-serif;padding:18px;max-width:520px;margin:auto}
h1{font-size:20px;margin:0 0 14px}label{display:block;margin:12px 0 4px;color:#aaa;font-size:14px}
input{width:100%;padding:12px;font-size:16px;background:#22222a;color:#fff;border:1px solid #444;border-radius:8px}
button{width:100%;margin-top:12px;padding:13px;font-size:16px;border:0;border-radius:8px;background:#3a3a48;color:#fff}
button.go{background:#7a2b2b}button:disabled{opacity:.5}
#out{margin-top:16px;padding:12px;background:#1d1d24;border-radius:8px;min-height:44px;white-space:pre-wrap;word-break:break-all}
.pw{font:bold 30px monospace;letter-spacing:3px;color:#ffd36b;display:block;margin:8px 0}
.err{color:#ff8a80}table{width:100%;border-collapse:collapse;font-size:14px}td{padding:6px 4px;border-bottom:1px solid #2c2c36}
.small{color:#888;font-size:13px}
</style></head><body>
<h1>Pixelia 관리자 <span class="small">서버 v10</span></h1>
<label for="k">관리자 키</label><input id="k" type="password" autocomplete="off">
<label for="i">아이디</label><input id="i" autocapitalize="off" autocomplete="off" spellcheck="false" maxlength="12" placeholder="영문 소문자·숫자 4~12자">
<button id="reset" class="go">임시 비밀번호 발급</button>
<button id="list">아이디 목록 보기</button>
<div id="out" class="small">관리자 키는 이 화면을 닫으면 지워져요.</div>
<script>
const $=(id)=>document.getElementById(id),out=$("out");
const ERR={key:"관리자 키가 틀렸어요.",off:"관리자 키가 아직 설정되지 않았어요 (Cloudflare의 비밀 값 ADMIN_KEY, 12자 이상).",id:"아이디는 영문 소문자·숫자 4~12자예요.",none:"그런 아이디는 없어요.",server:"서버 오류예요. 잠시 뒤 다시 해 보세요.",bad:"잘못된 요청이에요."};
function msg(t,err){out.className=err?"err":"";out.textContent=t;}
function fail(r){let t=ERR[r.e]||("오류: "+r.e);if(r.e==="wait")t="관리자 키를 여러 번 틀려서 "+Math.ceil(r.s/60)+"분 뒤에 다시 할 수 있어요.";if(r.e==="key"&&r.left)t+=" (남은 기회 "+r.left+"번)";if(r.e==="key"&&r.left===0)t+=" 10분 동안 잠겼어요.";msg(t,1);}
function when(t){if(!t)return"저장 없음";const d=new Date(t),p=(n)=>String(n).padStart(2,"0");return d.getFullYear()+"-"+p(d.getMonth()+1)+"-"+p(d.getDate())+" "+p(d.getHours())+":"+p(d.getMinutes());}
async function post(path,body){const b=[$("reset"),$("list")];b.forEach(x=>x.disabled=true);try{const r=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return await r.json();}catch(e){return{ok:0,e:"server"};}finally{b.forEach(x=>x.disabled=false);}}
let armed="",armT=0;
$("reset").onclick=async()=>{
 const id=$("i").value.trim().toLowerCase();$("i").value=id;
 if(!/^[a-z0-9]{4,12}$/.test(id))return msg(ERR.id,1);
 if(armed!==id||Date.now()-armT>5000){armed=id;armT=Date.now();$("reset").textContent="'"+id+"' 정말 바꿀까요? 한 번 더 누르기";return;}
 armed="";$("reset").textContent="임시 비밀번호 발급";msg("바꾸는 중…");
 const r=await post("/admin/reset",{key:$("k").value,id});
 if(!r.ok)return fail(r);
 out.className="";out.textContent="";
 out.append(id+"의 임시 비밀번호");const s=document.createElement("span");s.className="pw";s.textContent=r.pw;out.append(s);
 out.append("마지막 저장: "+when(r.at)+"\\n로그인돼 있던 기기는 모두 로그아웃됐어요. 캐릭터는 그대로예요.\\n이 화면을 닫으면 다시 볼 수 없으니 플레이어에게 바로 전해 주세요.");
};
$("i").oninput=()=>{armed="";$("reset").textContent="임시 비밀번호 발급";};
$("list").onclick=async()=>{
 msg("불러오는 중…");const r=await post("/admin/list",{key:$("k").value});
 if(!r.ok)return fail(r);
 out.className="";out.textContent="계정 "+r.l.length+"개"+(r.miss?" (일부 못 읽음: "+r.miss+")":"");
 const t=document.createElement("table");
 for(const [id,at,n] of r.l){const tr=t.insertRow();tr.insertCell().textContent=id;tr.insertCell().textContent=when(at);tr.insertCell().textContent="기기 "+n;tr.onclick=()=>{$("i").value=id;$("i").oninput();};}
 out.append(t);if(r.l.length)out.append("\\n아이디를 누르면 위 칸에 채워져요.");
};
</script></body></html>`;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		const ns = Object.values(env).find((v) => v && typeof v.idFromName === "function"); // the Durable Object binding, whatever it is called
		if (url.pathname === "/where" && ns) { // (v6.1) 방 1이 어디 있나 (?all: 방 1~9와 로비를 모두 — 없으면 여기 근처에 만든다)
			const names = url.searchParams.has("all") ? ["train-1", "train-2", "train-3", "train-4", "train-5", "train-6", "train-7", "train-8", "train-9", "lobby"] : ["train-1"];
			const out = [];
			for (const n of names) {
				try {
					out.push(n + ": " + (await (await ns.get(ns.idFromName(ROOMS + n), { locationHint: PLACE }).fetch(new Request("https://room/where"))).text()));
				} catch (e) {
					out.push(n + ": ?");
				}
			}
			return new Response(out.join("\n") + "\n(v9 · " + PLACE + " · 이 요청이 들어온 곳 " + ((request.cf && request.cf.colo) || "?") + ")", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		if (url.pathname === "/admin" || url.pathname.startsWith("/admin/")) return adminRoute(request, url, ns); // (v10) 관리자
		if (url.pathname.startsWith("/acct/")) { // (v9) 계정
			if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
			if (request.method !== "POST" || !/^\/acct\/(signup|login|load|save|logout)$/.test(url.pathname)) return J({ ok: 0, e: "bad" }, 404);
			if (!ns) return J({ ok: 0, e: "server" }, 500);
			const body = (await request.text()).slice(0, ACCT_MAX + 2000);
			const idm = /"id"\s*:\s*"([a-z0-9]{4,12})"/.exec(body);
			if (!idm) return J({ ok: 0, e: "id" });
			try {
				return await ns.get(ns.idFromName("acct-" + idm[1][0]), { locationHint: PLACE }).fetch(new Request("https://room" + url.pathname, { method: "POST", body }));
			} catch (e) {
				return J({ ok: 0, e: "server" }, 500);
			}
		}
		const m = /^\/ws\/(train-(?:[1-9]|1[0-9])|lobby|raid-[a-z0-9]{4,8})$/.exec(url.pathname);
		if (!m) return new Response("pixel rpg room server: ok (v9) · edge " + ((request.cf && request.cf.colo) || "?") + " · admin v10", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
		if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("websocket only", { status: 426 });
		if (!ns) return new Response("no durable object binding", { status: 500 });
		return ns.get(ns.idFromName(ROOMS + m[1]), { locationHint: PLACE }).fetch(request); // (v6.2) 새 이름의 방: 처음 만들 땐 동북아시아에
	},
};
