/**
 * Push-to-talk for the DSH composer: hold Space to record, release to
 * transcribe, and the transcript lands in the draft.
 *
 * This is a hand-authored client bundle: it follows the lazy-CJS contract the
 * client module system expects (`window.__ModuleLoader__.load({ id, factory })`)
 * so it needs no build step. It depends on nothing beyond the frozen platform
 * module table plus the speech Remote that the enabled voice input bundle
 * already mounts, so it never touches the shipped app archive.
 */
window.__ModuleLoader__.load({
	id: "dsh-voice-push-to-talk",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const h = react.createElement;
		const NS = "dsh-voice-push-to-talk";

		/* ------------------------------------------------------------------ *
		 * Diagnostics sink.
		 *
		 * A browser plugin cannot write files, and the console is not reachable
		 * for everyone. Local Storage is the one durable channel: Chromium keeps
		 * it in a LevelDB under the app's user-data directory, so the plugin's
		 * own trace survives on disk and can be read afterwards. Entries stay
		 * pure ASCII so they remain greppable in the raw store.
		 * ------------------------------------------------------------------ */

		const LOG_KEY = "dsh-voice-push-to-talk.trace";
		const LOG_MAX = 120;

		/** Append one entry to the on-disk trace. Never throws. */
		function logLine(event, details) {
			try {
				const entry = { at: Date.now(), event };
				if (details !== undefined) entry.detail = details;
				const line = JSON.stringify(entry).replace(
					/[^\x20-\x7e]/g,
					(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
				);
				const previous = localStorage.getItem(LOG_KEY);
				const lines = previous ? JSON.parse(previous) : [];
				lines.push(line);
				while (lines.length > LOG_MAX) lines.shift();
				localStorage.setItem(LOG_KEY, JSON.stringify(lines));
			} catch {
				/* diagnostics must never break the feature */
			}
		}

		/** Trace to the on-disk log and to the console. */
		function logEvent(event, details) {
			logLine(event, details);
			console.warn(`[${NS}] ${event}`, details ?? "");
		}

		/** A short, serializable description of a DOM node for the trace. */
		function describeNode(node) {
			if (node === null || node === undefined) return "none";
			if (typeof node !== "object") return String(node);
			const tag = node.tagName ?? node.constructor?.name ?? "?";
			const role = typeof node.getAttribute === "function" ? node.getAttribute("role") : null;
			return `${tag}${role ? `[role=${role}]` : ""}${node.isContentEditable ? "[contenteditable]" : ""}`;
		}

		/** Hold beyond this to be treated as push-to-talk rather than a space. */
		const HOLD_MS = 220;
		/**
		 * The Host catalog supplies the selected provider/language and the size
		 * limits. Recording must never wait on it: an unresolved unary call would
		 * strand the hold in "starting" with no message, and the Host falls back to
		 * its configured selection when the request carries none.
		 */
		const CATALOG_TIMEOUT_MS = 1500;
		/** A hold that neither starts nor fails within this window reports instead of hanging. */
		const BEGIN_TIMEOUT_MS = 3000;
		/** How long a hold waits for the speech Remote to appear before reporting. */
		const SPEECH_WAIT_MS = 1200;
		/** Recording cap used until the Host catalog reports its own limit. */
		const FALLBACK_MAX_SECONDS = 60;
		/** Provider phases in which the recognizer can accept audio. */
		const USABLE_PHASES = ["ready", "standby", "waking"];

		/* ------------------------------------------------------------------ *
		 * Canonical 16 kHz mono PCM16 WAV — the only container the Host accepts.
		 * ------------------------------------------------------------------ */

		function encodeWave(samples) {
			const bytes = new Uint8Array(44 + samples.length * 2);
			const view = new DataView(bytes.buffer);
			const text = (at, value) => {
				for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i);
			};
			text(0, "RIFF");
			view.setUint32(4, bytes.length - 8, true);
			text(8, "WAVE");
			text(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, 16000, true);
			view.setUint32(28, 32000, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			text(36, "data");
			view.setUint32(40, samples.length * 2, true);
			for (let i = 0; i < samples.length; i++) {
				const sample = Math.max(-1, Math.min(1, samples[i]));
				view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
			}
			return bytes;
		}

		function audioBase64(bytes) {
			let text = "";
			for (let i = 0; i < bytes.length; i += 8192) text += String.fromCharCode(...bytes.subarray(i, i + 8192));
			return btoa(text);
		}

		/* ------------------------------------------------------------------ *
		 * One microphone acquisition.
		 * ------------------------------------------------------------------ */

		class Capture {
			constructor() {
				this.chunks = [];
				this.lifetime = new AbortController();
				this.disposal = null;
			}

			async start() {
				const devices = navigator.mediaDevices;
				if (!devices || typeof MediaRecorder === "undefined") throw new Error("此浏览器不支持录音");
				let stream;
				try {
					stream = await devices.getUserMedia({
						audio: { echoCancellation: true, noiseSuppression: true },
						video: false
					});
				} catch (error) {
					if (error instanceof DOMException && error.name === "NotAllowedError") throw new Error("麦克风权限被拒绝");
					throw new Error("无法打开麦克风");
				}
				if (this.lifetime.signal.aborted) {
					stream.getTracks().forEach((track) => track.stop());
					throw new Error("已取消");
				}
				this.stream = stream;
				this.context = new AudioContext();
				this.samples = new Float32Array(256);
				this.analyser = this.context.createAnalyser();
				this.analyser.fftSize = this.samples.length;
				this.context.createMediaStreamSource(stream).connect(this.analyser);
				this.recorder = new MediaRecorder(stream);
				this.recorder.ondataavailable = (event) => {
					if (!this.lifetime.signal.aborted && event.data.size > 0) this.chunks.push(event.data);
				};
				this.recorder.start();
			}

			amplitude() {
				if (!this.analyser) return 0;
				this.analyser.getFloatTimeDomainData(this.samples);
				let sum = 0;
				for (const sample of this.samples) sum += sample * sample;
				return Math.sqrt(sum / this.samples.length);
			}

			async stop(maxSeconds) {
				const recorder = this.recorder;
				const context = this.context;
				if (!recorder || !context || recorder.state !== "recording") {
					await this.dispose();
					throw new Error("没有录到声音");
				}
				try {
					await new Promise((resolve, reject) => {
						recorder.onstop = () => resolve();
						recorder.onerror = () => reject(new Error("录音中断"));
						recorder.stop();
					});
					this.stream?.getTracks().forEach((track) => track.stop());
					this.lifetime.signal.throwIfAborted();
					const blob = new Blob(this.chunks, { type: recorder.mimeType });
					if (blob.size === 0) throw new Error("没有录到声音");
					const decoded = await context.decodeAudioData(await blob.arrayBuffer());
					this.lifetime.signal.throwIfAborted();
					const seconds = Math.max(0.05, Math.min(decoded.duration, maxSeconds));
					const offline = new OfflineAudioContext(1, Math.max(1, Math.floor(seconds * 16000)), 16000);
					const source = offline.createBufferSource();
					source.buffer = decoded;
					source.connect(offline.destination);
					source.start();
					const resampled = await offline.startRendering();
					this.lifetime.signal.throwIfAborted();
					return encodeWave(resampled.getChannelData(0));
				} finally {
					await this.dispose();
				}
			}

			dispose() {
				if (!this.disposal) {
					const closing = Promise.withResolvers();
					this.disposal = closing.promise;
					this.release().then(closing.resolve, closing.reject);
				}
				return this.disposal;
			}

			async release() {
				this.lifetime.abort(new Error("cancelled"));
				if (this.recorder?.state === "recording") this.recorder.stop();
				this.stream?.getTracks().forEach((track) => track.stop());
				try {
					await this.context?.close();
				} catch {
					/* a closed or never-opened context needs no further release */
				}
			}
		}

		/* ------------------------------------------------------------------ *
		 * Key handling and recording lifecycle.
		 *
		 * The engine owns the document listeners and the microphone; the React
		 * component only mirrors its state and keeps it supplied with the
		 * composer's insertion actions.
		 * ------------------------------------------------------------------ */

		/** Whether an element is a text input the user could be typing into. */
		function isEditable(element) {
			return Boolean(
				element && (element.tagName === "TEXTAREA" || element.isContentEditable || element.getAttribute("role") === "textbox")
			);
		}

		function createEngine(ctx) {
			const listeners = new Set();
			/** Anchor inside the composer; focus outside its subtree is never captured. */
			let engineElement = null;
			let snapshot = { phase: "idle", elapsed: 0, level: 0, message: "", armed: false, hint: "" };
			const publish = (patch) => {
				snapshot = { ...snapshot, ...patch };
				for (const listener of listeners) listener();
			};

			const state = {
				actions: null,
				locked: false,
				phase: "idle",
				capture: null,
				abort: null,
				holdTimer: null,
				ticker: null,
				startedAt: 0,
				releasedDuringStart: false,
				catalog: null,
				maxSeconds: FALLBACK_MAX_SECONDS,
				maxAudioBytes: Number.POSITIVE_INFINITY,
				selection: {},
				speechScope: null,
				speechWaiter: null,
				clearTimer: null,
				hintTimer: null,
				watchdog: null,
				attached: false,
				disposed: false
			};

			/**
			 * Report why a held Space was not claimed, at most three times per
			 * reason: enough to explain a different editor, never a console flood.
			 * The same reason is also surfaced in the composer chip, so the blocker
			 * is visible without opening DevTools.
			 */
			const notes = {};
			const REASON_TEXT = {
				"composer actions missing": "没有草稿句柄",
				"composer locked": "输入框已锁定",
				"focused editor is outside the composer scope": "焦点不在输入框"
			};

			function note(reason, detail) {
				const seen = notes[reason] ?? 0;
				notes[reason] = seen + 1;
				// The first few occurrences reach the trace: a stall flood would
				// otherwise evict the events that matter from the ring buffer.
				if (seen < 3) {
					logLine("stall", {
						reason,
						seen: seen + 1,
						focus: describeNode(document.activeElement),
						scope: describeNode(editableScope(engineElement)),
						anchor: describeNode(engineElement),
						actions: Boolean(composerActions()),
						locked: state.locked
					});
				}
				if (seen < 3) console.warn(`[${NS}] 长按空格没有接管：${reason}`, detail);
				if (state.hintTimer) clearTimeout(state.hintTimer);
				publish({ hint: REASON_TEXT[reason] ?? reason });
				state.hintTimer = setTimeout(() => {
					if (!state.disposed) publish({ hint: "" });
				}, 5000);
			}

			function setPhase(phase, patch) {
				state.phase = phase;
				publish({ phase, ...patch });
			}

			/** Drop a stall hint as soon as a hold is claimed. */
			function clearHint() {
				if (state.hintTimer) {
					clearTimeout(state.hintTimer);
					state.hintTimer = null;
				}
				if (snapshot.hint !== "") publish({ hint: "" });
			}

			function fail(message) {
				logLine("fail", { message, phase: state.phase });
				setPhase("error", { elapsed: 0, level: 0, message });
				if (state.clearTimer) clearTimeout(state.clearTimer);
				state.clearTimer = setTimeout(() => {
					if (!state.disposed && state.phase === "error") setPhase("idle", { message: "" });
				}, 6000);
			}

			/**
			 * Resolve the speech Remote.
			 *
			 * Cordis refuses to read a service property the context did not inject,
			 * so the handle comes from a child context that injected both `remote`
			 * and `remote.speech`, read lazily through it. That child fiber is never
			 * awaited: if the voice input Bundle is disabled only the child waits,
			 * while this entry still activates — a plugin whose activation waits on
			 * another plugin's service is a fatal startup failure for the audit.
			 */
			function speechRemote() {
				if (!state.speechScope) return null;
				try {
					return state.speechScope.remote?.speech ?? null;
				} catch (error) {
					logLine("speech-read-failed", { message: String(error?.message ?? error) });
					return null;
				}
			}

			/** Wait briefly for the speech Remote so the first hold is not a coin flip. */
			function waitForSpeech(ms) {
				if (speechRemote()) return Promise.resolve(true);
				return new Promise((resolve) => {
					const timer = setTimeout(() => {
						state.speechWaiter = null;
						resolve(false);
					}, ms);
					state.speechWaiter = () => {
						clearTimeout(timer);
						resolve(true);
					};
				});
			}

			/**
			 * The composer's draft actions, resolved without depending on any slot
			 * mounting: the session binding publishes `inputActions` for the session
			 * the main view currently shows. The slot contribution, when it mounts,
			 * supplies the same handle as the first choice.
			 */
			function composerActions() {
				if (state.actions) return state.actions;
				try {
					const binding = ctx.get?.("uiSession")?.current?.getSnapshot?.();
					return binding?.props?.inputActions ?? null;
				} catch {
					return null;
				}
			}

			/** Record that a usable draft handle exists and drop the fallback notice. */
			function markArmed(source) {
				if (state.attached) return;
				state.attached = true;
				removeFallbackNotice();
				publish({ armed: true });
				logEvent("armed", { source, uiSession: Boolean(ctx.get?.("uiSession")) });
			}

			/**
			 * Read the Host catalog once per session: selection plus the size limits.
			 * Bounded by a timeout so a stalled unary call cannot hold the hold.
			 */
			async function readCatalog() {
				if (state.catalog) return state.catalog;
				const speech = speechRemote();
				if (!speech?.catalog) return null;
				try {
					let timer = null;
					const timeout = new Promise((resolve) => {
						timer = setTimeout(() => resolve(null), CATALOG_TIMEOUT_MS);
					});
					const result = await Promise.race([speech.catalog(), timeout]);
					if (timer !== null) clearTimeout(timer);
					if (result === null) {
						logLine("catalog-timeout", { afterMs: CATALOG_TIMEOUT_MS });
						return null;
					}
					const value = result && typeof result.ok === "boolean" ? (result.ok ? result.value : null) : result;
					if (value) state.catalog = value;
				} catch (error) {
					logLine("catalog-failed", { message: String(error?.message ?? error) });
				}
				return state.catalog;
			}

			function stopTicker() {
				if (state.ticker) clearInterval(state.ticker);
				state.ticker = null;
			}

			function startTicker() {
				stopTicker();
				state.ticker = setInterval(() => {
					if (state.phase !== "recording") return;
					const elapsed = (Date.now() - state.startedAt) / 1000;
					publish({ elapsed, level: state.capture ? state.capture.amplitude() : 0 });
					if (elapsed >= state.maxSeconds) finish();
				}, 100);
			}

			async function begin() {
				const bail = (why) => {
					logLine("begin-bail", { why, phase: state.phase, locked: state.locked, actions: Boolean(composerActions()) });
				};
				if (state.disposed) return bail("disposed");
				if (state.phase !== "pending") return bail("phase");
				if (!composerActions()) return bail("no-actions");
				if (state.locked) return bail("locked");
				if (!speechRemote() && !(await waitForSpeech(SPEECH_WAIT_MS))) {
					fail("语音服务未就绪：请先在插件页启用语音输入 Bundle");
					return;
				}
				if (state.phase !== "pending") return bail("released-while-waiting");
				setPhase("starting", { message: "" });
				// An exception here used to leave the phase stuck with no message at all.
				try {
					return await startRecording();
				} catch (error) {
					logLine("begin-threw", { message: String(error?.message ?? error) });
					if (!state.disposed) fail(`录音启动失败：${String(error?.message ?? error)}`);
				}
			}

			async function startRecording() {
				const catalog = await readCatalog();
				logLine("catalog", {
					hasCatalog: catalog !== null,
					selection: catalog?.selection ?? null,
					maxSeconds: catalog?.maxDurationSeconds ?? null
				});
				const selection = catalog?.selection;
				const provider = catalog?.providers?.find((item) => item.id === selection?.providerId);
				const readiness = provider?.preparation?.phase;
				if (readiness && !USABLE_PHASES.includes(readiness)) {
					fail("语音模型还没准备好：先用麦克风按钮完成「下载并准备」");
					return;
				}
				state.selection = {};
				if (selection?.providerId) state.selection.providerId = selection.providerId;
				if (selection?.language) state.selection.language = selection.language;
				if (typeof catalog?.maxDurationSeconds === "number") state.maxSeconds = catalog.maxDurationSeconds;
				if (typeof catalog?.maxAudioBytes === "number") state.maxAudioBytes = catalog.maxAudioBytes;

				const capture = new Capture();
				state.capture = capture;
				state.releasedDuringStart = false;
				try {
					await capture.start();
				} catch (error) {
					state.capture = null;
					// A cancelled acquisition is not a failure: the phase already
					// moved on (Escape, blur, or a superseded hold).
					if (state.disposed || state.phase !== "starting") return;
					fail(error instanceof Error ? error.message : String(error));
					return;
				}
				if (state.disposed || state.releasedDuringStart || state.phase !== "starting") {
					state.capture = null;
					await capture.dispose();
					if (!state.disposed) setPhase("idle", { elapsed: 0, level: 0 });
					return;
				}
				state.abort = new AbortController();
				state.startedAt = Date.now();
				setPhase("recording", { elapsed: 0, level: 0, message: "" });
				startTicker();
				logLine("record-start", { maxSeconds: state.maxSeconds, selection: state.selection });
			}

			async function finish() {
				const capture = state.capture;
				if (!capture || state.phase !== "recording") return;
				stopTicker();
				setPhase("transcribing", { level: 0, message: "" });
				try {
					const bytes = await capture.stop(state.maxSeconds);
					if (state.disposed) return;
					logLine("record-stop", { bytes: bytes.byteLength });
					if (bytes.byteLength > state.maxAudioBytes) {
						fail("录音超出本机允许的大小");
						return;
					}
					const speech = speechRemote();
					if (!speech?.transcribe) {
						fail("语音服务未启用：请先在插件页启用语音输入 Bundle");
						return;
					}
					const result = await speech.transcribe({ audioBase64: audioBase64(bytes), ...state.selection }, state.abort.signal);
					if (state.disposed) return;
					logLine("transcribe", {
						ok: Boolean(result?.ok),
						error: result?.error?.message ?? "",
						text: result?.value?.text ?? ""
					});
					if (!result?.ok) {
						fail(result?.error?.message ? `转写失败：${result.error.message}` : "转写失败");
						return;
					}
					const text = result.value?.text ?? "";
					if (text === "") {
						fail("没有识别到语音");
						return;
					}
					const actions = composerActions();
					const inserted = Boolean(actions?.insertText(text, actions.captureInsertion()));
					logLine("insert", { ok: inserted, length: text.length, source: state.actions ? "slot" : "session binding" });
					if (!inserted) {
						fail("草稿已变化，转写结果没有插入");
						return;
					}
					setPhase("idle", { elapsed: 0, level: 0, message: "" });
				} catch (error) {
					if (!state.disposed) fail(error instanceof Error ? error.message : String(error));
				} finally {
					state.capture = null;
					state.abort = null;
				}
			}

			async function cancel() {
				if (state.holdTimer) clearTimeout(state.holdTimer);
				state.holdTimer = null;
				stopTicker();
				const capture = state.capture;
				state.capture = null;
				state.abort?.abort();
				state.abort = null;
				if (capture) await capture.dispose().catch(() => undefined);
				if (!state.disposed && state.phase !== "idle") setPhase("idle", { elapsed: 0, level: 0, message: "" });
			}

			/** A short tap still types a space; only a hold becomes a recording. */
			function emitSpace() {
				try {
					const actions = composerActions();
					const span = actions?.captureInsertion();
					const ok = Boolean(actions?.insertText(" ", span));
					logLine("tap-space", { ok, hasActions: Boolean(actions) });
				} catch (error) {
					logLine("tap-space", { ok: false, error: String(error?.message ?? error) });
				}
			}

			/**
			 * The nearest ancestor of the anchor that holds an editable element.
			 *
			 * Scoping to this element — rather than to any ancestor that happens to
			 * contain the focused node — is what keeps Space in other panels (a
			 * sidebar editor shares the app shell with the composer) untouched.
			 */
			function editableScope(element) {
				for (let node = element?.parentElement ?? null, depth = 0; node && depth < 12; node = node.parentElement ?? null, depth++) {
					if (node === document.body || node.tagName === "HTML") break;
					if (typeof node.querySelector !== "function") continue;
					if (node.querySelector("textarea, [contenteditable], [role='textbox']")) return node;
				}
				return null;
			}

			/** True only while an editable element inside the composer owns focus. */
			function ownsFocus(element) {
				const active = document.activeElement;
				if (!active || active === document.body) return false;
				if (!isEditable(active)) return false;
				const scope = editableScope(element);
				return scope !== null && scope.contains(active);
			}

			const spaceTrace = { count: 0 };

			const onKeyDown = (event) => {
				if (state.disposed || event.code !== "Space") return;
				// Never take Space away from an IME candidate list or from a shortcut.
				if (event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
				if (state.phase === "pending" || state.phase === "starting" || state.phase === "recording") {
					event.preventDefault();
					return;
				}
				// Trace the first few decisions: this records what the page actually
				// looked like when a held Space arrived.
				if (spaceTrace.count < 8) {
					spaceTrace.count += 1;
					logLine("space", {
						focus: describeNode(document.activeElement),
						editable: isEditable(document.activeElement),
						anchor: describeNode(engineElement),
						scope: describeNode(editableScope(engineElement)),
						actions: Boolean(composerActions()),
						locked: state.locked,
						phase: state.phase
					});
				}
				if (state.phase === "error") {
					// A fresh attempt clears the previous message instead of waiting
					// out its timer, so a failed recording is retryable immediately.
					if (state.clearTimer) clearTimeout(state.clearTimer);
					setPhase("idle", { message: "" });
				}
				if (state.phase !== "idle") return;
				if (state.locked) {
					note("composer locked", { locked: state.locked });
					return;
				}
				const actions = composerActions();
				if (!actions) {
					note("composer actions missing", "没有拿到草稿插入句柄");
					return;
				}
				if (!ownsFocus(engineElement)) {
					note(
						"focused editor is outside the composer scope",
						isEditable(document.activeElement)
							? { scope: editableScope(engineElement), focused: document.activeElement, anchor: engineElement }
							: { focused: document.activeElement, reason: "焦点不在可编辑元素上" }
					);
					return;
				}
				markArmed(state.actions ? "slot" : "session binding");
				event.preventDefault();
				clearHint();
				setPhase("pending", { message: "" });
				state.pressedAt = Date.now();
				state.holdTimer = setTimeout(async () => {
					state.holdTimer = null;
					const enteredAt = Date.now();
					logLine("hold-timer", {
						afterMs: enteredAt - state.pressedAt,
						phase: state.phase,
						beginType: typeof begin
					});
					// Instrument the call site too: begin()'s own guards cannot report
					// anything if it never runs or rejects, and a hang reports nothing
					// either — so every outcome lands in the trace and on screen.
					try {
						let timer = null;
						const stallGuard = new Promise((resolve) => {
							timer = setTimeout(() => resolve("timeout"), BEGIN_TIMEOUT_MS);
						});
						const outcome = await Promise.race([begin().then(() => "done"), stallGuard]);
						if (timer !== null) clearTimeout(timer);
						logLine("begin-returned", { ms: Date.now() - enteredAt, phase: state.phase, outcome });
						if (!state.disposed && outcome === "timeout") {
							logEvent("begin-timeout", { phase: state.phase });
							fail("录音启动超时（详见日志）");
						} else if (!state.disposed && state.phase === "pending") {
							fail("录音没有启动（详见日志）");
						}
					} catch (error) {
						logEvent("begin-rejected", {
							message: String(error?.message ?? error),
							stack: String(error?.stack ?? "").slice(0, 300)
						});
						if (!state.disposed) fail(`录音启动异常：${String(error?.message ?? error)}`);
					}
				}, HOLD_MS);
			};

			const onKeyUp = (event) => {
				if (state.disposed || event.code !== "Space") return;
				logLine("keyup", { phase: state.phase, heldMs: state.pressedAt ? Date.now() - state.pressedAt : null });
				if (state.phase === "pending") {
					if (state.holdTimer) clearTimeout(state.holdTimer);
					state.holdTimer = null;
					setPhase("idle", { message: "" });
					emitSpace();
					return;
				}
				if (state.phase === "starting") {
					state.releasedDuringStart = true;
					return;
				}
				if (state.phase === "recording") {
					event.preventDefault();
					finish();
				}
			};

			const onEscape = (event) => {
				if (event.key !== "Escape" || state.disposed) return;
				if (state.phase === "pending" || state.phase === "starting" || state.phase === "recording") {
					event.preventDefault();
					cancel();
				}
			};

			const onBlur = () => {
				if (state.phase === "recording" || state.phase === "starting") cancel();
			};

			const onVisibility = () => {
				if (document.visibilityState === "hidden") onBlur();
			};

			return {
				subscribe(listener) {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot() {
					return snapshot;
				},
				/** The component reports the live composer actions and lock state. */
				configure({ actions, locked }) {
					state.actions = actions ?? null;
					state.locked = Boolean(locked);
					if (state.actions) markArmed("slot");
				},
				/** The injected context that can read `remote.speech` arrives here. */
				attachSpeechScope(scope) {
					state.speechScope = scope ?? null;
					logLine("speech-ready", {
						available: Boolean(scope),
						hasSpeech: Boolean(speechRemote()),
						hasCatalog: typeof speechRemote()?.catalog === "function",
						hasTranscribe: typeof speechRemote()?.transcribe === "function"
					});
					if (state.speechScope && state.speechWaiter) {
						const wake = state.speechWaiter;
						state.speechWaiter = null;
						wake();
					}
				},
				setElement(element) {
					engineElement = element;
				},
				start() {
					document.addEventListener("keydown", onKeyDown, true);
					document.addEventListener("keyup", onKeyUp, true);
					document.addEventListener("keydown", onEscape, true);
					window.addEventListener("blur", onBlur);
					document.addEventListener("visibilitychange", onVisibility);
					// If the composer slot never mounts, the chip cannot report
					// anything; a bounded on-page notice keeps this diagnosable.
					state.watchdog = setTimeout(() => {
						if (state.disposed || state.attached) return;
						if (composerActions()) {
							// The slot never mounted, but the session binding supplies the
							// handle: the feature works, only the chip is unavailable.
							markArmed("session binding");
							logEvent("watchdog", { outcome: "binding-handle", chipMounted: false });
							return;
						}
						logEvent("watchdog", { outcome: "no-handle", uiSession: Boolean(ctx.get?.("uiSession")) });
						showFallbackNotice("长按空格不可用：没有拿到草稿插入句柄");
					}, 5000);
				},
				async dispose() {
					state.disposed = true;
					document.removeEventListener("keydown", onKeyDown, true);
					document.removeEventListener("keyup", onKeyUp, true);
					document.removeEventListener("keydown", onEscape, true);
					window.removeEventListener("blur", onBlur);
					document.removeEventListener("visibilitychange", onVisibility);
					if (state.clearTimer) clearTimeout(state.clearTimer);
					if (state.hintTimer) clearTimeout(state.hintTimer);
					if (state.watchdog) clearTimeout(state.watchdog);
					removeFallbackNotice();
					await cancel();
					listeners.clear();
				}
			};
		}

		/* ------------------------------------------------------------------ *
		 * The chip rendered next to the mic button.
		 * ------------------------------------------------------------------ */

		const CHIP = {
			display: "inline-flex",
			alignItems: "center",
			gap: "6px",
			maxWidth: "min(420px, 46vw)",
			padding: "2px 8px",
			borderRadius: "999px",
			fontSize: "12px",
			lineHeight: "18px",
			whiteSpace: "nowrap",
			overflow: "hidden",
			textOverflow: "ellipsis"
		};

		/** Idle marker: proves the chip mounted and the plugin is armed. */
		const IDLE_DOT = {
			width: "6px",
			height: "6px",
			borderRadius: "50%",
			border: "1px solid currentColor",
			flex: "0 0 auto",
			opacity: "0.45"
		};

		/**
		 * On-page notice used only when the composer slot never mounts, where the
		 * chip cannot report anything because it was never rendered.
		 */
		let fallbackNotice = null;

		function showFallbackNotice(message) {
			if (fallbackNotice || typeof document === "undefined") return;
			const node = document.createElement("div");
			node.textContent = message;
			node.style.cssText = [
				"position:fixed",
				"left:12px",
				"bottom:12px",
				"z-index:2147483647",
				"padding:6px 10px",
				"border-radius:6px",
				"background:rgba(212,56,13,0.92)",
				"color:#fff",
				"font:12px/16px system-ui,sans-serif",
				"pointer-events:none"
			].join(";");
			document.body.appendChild(node);
			fallbackNotice = node;
		}

		function removeFallbackNotice() {
			if (fallbackNotice?.parentNode) fallbackNotice.parentNode.removeChild(fallbackNotice);
			fallbackNotice = null;
		}

		function PushToTalk({ inputActions, locked, engine, t }) {
			const snapshot = react.useSyncExternalStore(engine.subscribe, engine.getSnapshot);
			// A ref object keeps the anchor stable across renders, so the engine
			// never needs a state update just to learn its composer position.
			const anchor = react.useRef(null);
			const text = (key, fallback) => (typeof t === "function" ? t(key) : fallback);

			react.useEffect(() => {
				engine.setElement(anchor.current);
			}, [engine]);

			react.useEffect(() => {
				engine.configure({ actions: inputActions, locked });
			});

			react.useEffect(() => () => engine.configure({ actions: null, locked: true }), [engine]);

			const recording = snapshot.phase === "recording" || snapshot.phase === "starting";
			const transcribing = snapshot.phase === "transcribing";
			const failed = snapshot.phase === "error";
			const warned = snapshot.hint !== "" && !recording && !transcribing && !failed;
			// Idle still renders: without a marker the user cannot tell "loaded but
			// not claiming" apart from "not loaded at all".
			const active = recording || transcribing || failed || warned || !snapshot.armed;
			const color = failed || recording ? "#d4380d" : warned || !snapshot.armed ? "#ad6800" : "#8c8c8c";
			const label = failed
				? snapshot.message
				: snapshot.hint
					? `长按不可用：${snapshot.hint}`
					: recording
						? `${text("recording", "松手转文字")} ${snapshot.elapsed.toFixed(1)}s`
						: snapshot.armed
							? ""
							: "长按不可用：输入区未就绪";

			return h(
				"span",
				{
					ref: anchor,
					style: active ? { ...CHIP, color, background: "rgba(127,127,127,0.10)" } : { ...CHIP, color, padding: "2px" },
					title: text("hint", "长按空格说话，松开自动转文字；短按空格仍然是空格")
				},
				recording
					? h("span", {
							style: {
								width: "8px",
								height: "8px",
								borderRadius: "50%",
								background: "#d4380d",
								flex: "0 0 auto",
								opacity: String(Math.max(0.35, Math.min(1, 0.35 + snapshot.level * 12)))
							}
						})
					: h("span", { style: IDLE_DOT }),
				h("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } }, label)
			);
		}

		/* ------------------------------------------------------------------ *
		 * Mount.
		 * ------------------------------------------------------------------ */

		const inject = ["slots", "locale"];

		const zh = {
			pending: "松手取消，按住说话",
			starting: "正在打开麦克风…",
			recording: "松手转文字",
			transcribing: "转写中…",
			hint: "长按空格说话，松开自动转文字；短按空格仍然是空格"
		};

		const en = {
			pending: "Keep holding to talk",
			starting: "Opening the microphone…",
			recording: "Release to transcribe",
			transcribing: "Transcribing…",
			hint: "Hold Space to talk and release to transcribe; a tap still types a space"
		};

		function registerUi(ctx) {
			const engine = createEngine(ctx);
			ctx.effect(() => () => engine.dispose());
			engine.start();
			logEvent("listeners-attached");
			// Read the speech Remote from a context that injected it. This child
			// fiber is deliberately not awaited: if the voice input Bundle is
			// disabled the child stays pending, while this entry still activates.
			try {
				// `remote` must be injected too: reading `.remote` from a context that
				// only injected `remote.speech` throws "cannot get property remote".
				const child = ctx.inject(["remote", "remote.speech"], (speechCtx) => {
					engine.attachSpeechScope(speechCtx);
					return () => engine.attachSpeechScope(null);
				});
				if (typeof child?.then === "function") {
					child.then(undefined, (error) => logLine("speech-inject-child-failed", { message: String(error?.message ?? error) }));
				}
			} catch (error) {
				logLine("speech-inject-failed", { message: String(error?.message ?? error) });
			}
			try {
				ctx.effect(() => ctx.locale.register(NS, { zh, en }));
			} catch (error) {
				logLine("locale-register-failed", { message: String(error) });
			}
			// `conversation.input.activity` is a single-occupant slot: registering
			// there displaces the official voice input plugin and fails its boot.
			// `conversation.input.right` is a list slot in the same composer row.
			// Registration is guarded: a failed contribution must never abort the
			// whole web boot, since any non-active entry is fatal to startup.
			ctx.slots.inject("conversation.input.right", () => {
				logLine("slot-declared", { slot: "conversation.input.right" });
				try {
					const contribution = ctx.slots.register(
						{
							name: "conversation.input.right",
							// A list slot rejects a registration without an id:
							// "list slot ... requires options.id".
							id: "voice-push-to-talk",
							order: 5,
							locale: NS,
							inject: () => ({ engine })
						},
						PushToTalk
					);
					logLine("slot-registered", { slot: "conversation.input.right" });
					return contribution;
				} catch (error) {
					logEvent("slot-register-failed", { message: String(error), stack: String(error?.stack ?? "") });
					return () => {};
				}
			});
		}

		/**
		 * Activate the push-to-talk contribution.
		 *
		 * Only core client services are required, so this entry always reaches
		 * `active`: the speech Remote is resolved per recording, and its absence
		 * shows one explanatory message instead of blocking startup.
		 * @param ctx - Client runtime owning the slots and locale services.
		 * @returns disposer releasing the engine and its slot contribution.
		 */
		async function apply(ctx) {
			logEvent("activate", { version: "0.1.0" });
			const ui = ctx.inject(["slots", "locale"], registerUi);
			try {
				await ui;
			} catch (error) {
				await ui.dispose();
				throw error;
			}
			return async () => {
				await ui.dispose();
			};
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
