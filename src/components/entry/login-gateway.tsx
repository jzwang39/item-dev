"use client";

import { signIn } from "next-auth/react";
import { FormEvent, useEffect, useRef, useState } from "react";

type EntryRole = "admin" | "expert";

const invalidCredentialsMessage = "用户名或密码错误，请重试。";

const roleContent: Record<
  EntryRole,
  { eyebrow: string; title: string; description: string; action: string }
> = {
  admin: {
    eyebrow: "管理员入口",
    title: "管理员登录",
    description: "管理员负责命题工作、账号和权限分配。",
    action: "进入工作台"
  },
  expert: {
    eyebrow: "专家入口",
    title: "专家登录",
    description: "账号由管理员统一分配。如暂无账号或无法登录，请联系管理员。",
    action: "进入工作台"
  }
};

export function LoginGateway() {
  const [role, setRole] = useState<EntryRole | null>(null);
  const [error, setError] = useState("");
  const [pageError, setPageError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const callbackUrlRef = useRef("/workspace");

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const callbackUrl = parameters.get("callbackUrl");
    if (callbackUrl) {
      try {
        const target = new URL(callbackUrl, window.location.origin);
        if (
          target.origin === window.location.origin &&
          (target.pathname === "/workspace" || target.pathname.startsWith("/workspace/"))
        ) {
          callbackUrlRef.current = `${target.pathname}${target.search}`;
          setPageError("请重新登录，登录后将返回当前任务。");
        }
      } catch {
        // Ignore malformed return URLs and use the default workspace.
      }
    }
    const errorCode = parameters.get("error");
    if (!errorCode) {
      return;
    }

    setPageError(errorCode === "CredentialsSignin" ? invalidCredentialsMessage : "登录失败，请稍后重试。");
    parameters.delete("error");
    const search = parameters.toString();
    window.history.replaceState({}, "", `${window.location.pathname}${search ? `?${search}` : ""}`);
  }, []);

  useEffect(() => {
    if (!role) {
      return;
    }

    usernameRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setRole(null);
      }
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [role]);

  function openLogin(nextRole: EntryRole, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setError("");
    setPageError("");
    setRole(nextRole);
  }

  function closeLogin() {
    setRole(null);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!role) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    setSubmitting(true);
    setError("");

    try {
      const result = await signIn("credentials", {
        username: String(formData.get("username") ?? ""),
        password: String(formData.get("password") ?? ""),
        entryRole: role,
        redirect: false,
        callbackUrl: callbackUrlRef.current
      });

      if (!result?.ok) {
        setError(result?.error === "CredentialsSignin" ? invalidCredentialsMessage : "登录失败，请稍后重试。");
        return;
      }

      window.location.assign(callbackUrlRef.current);
    } catch {
      setError("登录失败，请稍后重试。");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="entry-page">
      <div className="entry-surface">
        <header className="entry-header">
          <div className="entry-header-inner">
            <div className="entry-brand">
              <div aria-hidden className="entry-brand-mark">
                <span>职</span>
              </div>
              <strong>技能人才评价国家题库智能命题平台</strong>
            </div>
          </div>
        </header>

        <div className="entry-hero">
          <section className="entry-copy">
            <p className="entry-badge">
              <i aria-hidden />
              智能体命题
            </p>
            <h1>
              技能人才评价
              <br />
              <em>题库智能命题</em>
            </h1>
            <p className="entry-description">
              以职业标准为依据，让智能体协作命题。
              <br />
              连接专家审定、题库沉淀与标准组卷。
            </p>
            <div className="entry-actions">
              <button
                className="entry-button primary"
                onClick={(event) => openLogin("admin", event.currentTarget)}
                type="button"
              >
                <span>管理员登录</span>
                <ArrowIcon />
              </button>
              <button
                className="entry-button secondary"
                onClick={(event) => openLogin("expert", event.currentTarget)}
                type="button"
              >
                <PlayIcon />
                <span>专家登录</span>
              </button>
            </div>
            {pageError ? (
              <p aria-live="polite" className="entry-login-message" role="alert">
                {pageError}
              </p>
            ) : null}
            <div className="entry-principles">
              <div>
                <strong>智能体</strong>
                <span>协作命题</span>
              </div>
              <div>
                <strong>专家</strong>
                <span>逐题审定</span>
              </div>
              <div>
                <strong>标准</strong>
                <span>结构组卷</span>
              </div>
            </div>
          </section>

          <div aria-hidden className="entry-visual">
            <i className="entry-orb orb-one" />
            <i className="entry-orb orb-two" />
            <div className="entry-float-card entry-agent-card">
              <span className="entry-card-label">智能体命题</span>
              <strong>从标准到题目</strong>
              <p>
                <i />依据 · 生成 · 校验
              </p>
            </div>
            <div className="entry-float-card entry-workspace-card">
              <div className="entry-card-heading">
                <div>
                  <span className="entry-card-label">命题工作区</span>
                  <strong>人机协同 · 专家审定</strong>
                </div>
                <span className="entry-card-symbol">
                  <DocumentIcon />
                </span>
              </div>
              <div className="entry-card-details">
                <div>
                  <span>命题依据</span>
                  <b>职业标准</b>
                </div>
                <div>
                  <span>题目归属</span>
                  <b>统一题库</b>
                </div>
              </div>
            </div>
          </div>
        </div>

        <footer className="entry-footer">
          <span>资料有据 · 命题有序 · 审定有责</span>
          <span>版权所有 © 现代职业教育研究院　京ICP备18024731号-1</span>
        </footer>
      </div>

      {role ? (
        <div
          aria-modal="true"
          className="entry-modal"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeLogin();
            }
          }}
          role="dialog"
        >
          <form className="entry-auth-card" onSubmit={handleSubmit}>
            <button aria-label={`关闭${roleContent[role].title}窗口`} className="entry-close" onClick={closeLogin} type="button">
              <CloseIcon />
            </button>
            <p className="entry-auth-eyebrow">{roleContent[role].eyebrow}</p>
            <h2>{roleContent[role].title}</h2>
            <p className="entry-auth-description">{roleContent[role].description}</p>
            <label className="auth-field">
              <span>账号</span>
              <input
                autoComplete="username"
                name="username"
                placeholder={role === "admin" ? "请输入管理员账号" : "请输入专家账号"}
                ref={usernameRef}
                required
              />
            </label>
            <label className="auth-field">
              <span>密码</span>
              <input autoComplete="current-password" name="password" placeholder="请输入密码" required type="password" />
            </label>
            {error ? (
              <p aria-live="polite" className="auth-message" role="alert">
                {error}
              </p>
            ) : null}
            <button className="auth-submit" disabled={submitting} type="submit">
              {submitting ? <span className="entry-spinner" /> : null}
              {submitting ? "正在验证身份…" : roleContent[role].action}
            </button>
            <p className="login-foot">账号由系统管理员创建和维护</p>
          </form>
        </div>
      ) : null}
    </main>
  );
}

function ArrowIcon() {
  return (
    <svg aria-hidden fill="none" viewBox="0 0 24 24">
      <path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg aria-hidden fill="none" viewBox="0 0 24 24">
      <path d="m8 5 11 7-11 7V5Z" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.6" />
    </svg>
  );
}

function DocumentIcon() {
  return (
    <svg aria-hidden fill="none" viewBox="0 0 24 24">
      <path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 9h8m-8 4h8m-8 4h5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden fill="none" viewBox="0 0 24 24">
      <path d="m6 6 12 12M6 18 18 6" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}
