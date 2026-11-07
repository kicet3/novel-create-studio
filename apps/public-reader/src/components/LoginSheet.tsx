/** 로그인 / 회원가입 (닉네임 + 비밀번호; e-mail 등 개인정보는 받지 않음). */
import { useState, type FormEvent } from "react";
import { errorText } from "../lib/data.js";
import { useSession } from "../lib/session.js";
import { Button, Message, Sheet } from "./ui.js";

export function LoginSheet() {
  const s = useSession();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [nickname, setNickname] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "login") await s.login(nickname, password);
      else await s.signup(nickname, password);
      setPassword("");
      s.afterLogin();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={s.loginOpen} title={mode === "login" ? "로그인" : "회원가입"} onClose={s.closeLogin}>
      <div className="pr-tabs" role="tablist" aria-label="로그인 방식">
        {(["login", "signup"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className="pr-tab" onClick={() => (setMode(m), setError(null))}>
            {m === "login" ? "로그인" : "회원가입"}
          </button>
        ))}
      </div>
      <form className="pr-form" onSubmit={submit}>
        <label className="pr-field">
          <span>닉네임</span>
          <input value={nickname} onChange={(e) => setNickname(e.target.value)} autoComplete="username" autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={16} required minLength={2} />
          {mode === "signup" && <small>2~16자, 한글·영문·숫자·_ . - 만 쓸 수 있어요.</small>}
        </label>
        <label className="pr-field">
          <span>비밀번호</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} maxLength={128} required />
          {mode === "signup" && <small>8자 이상. 비밀번호를 잊으면 되찾을 수 없어요(이메일을 받지 않습니다).</small>}
        </label>
        {error && <Message tone="danger">{error}</Message>}
        <Button type="submit" variant="primary" disabled={busy} className="pr-btn-block">
          {busy ? "잠시만요…" : mode === "login" ? "로그인" : "가입하고 시작하기"}
        </Button>
      </form>
    </Sheet>
  );
}
