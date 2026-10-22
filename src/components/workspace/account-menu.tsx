"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import { signOut } from "next-auth/react";

import type { AccountRole } from "@/modules/auth/repository";

export function AccountMenu({
  displayName,
  role
}: Readonly<{
  displayName: string;
  role: AccountRole;
}>) {
  const [open, setOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const roleLabel = role === "admin" ? "管理员" : "专家";

  return (
    <div className="relative" ref={menuRef}>
      <button
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left transition hover:bg-[#f6f8fc]"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <span className="grid h-9 w-9 place-items-center rounded-full bg-[#eef2ff] text-sm font-semibold text-[#3f60e8]">
          {displayName.slice(0, 1)}
        </span>
        <span className="hidden sm:block">
          <span className="block text-sm font-medium text-[#293242]">{displayName}</span>
          <span className="block text-xs text-[#768091]">{roleLabel}</span>
        </span>
        <span aria-hidden className="text-xs text-[#768091]">
          {open ? "⌃" : "⌄"}
        </span>
      </button>

      {open ? (
        <div className="absolute right-0 z-20 mt-2 w-[216px] overflow-hidden rounded-xl border border-[#e7eaf0] bg-white py-2 shadow-popover">
          <div className="border-b border-[#eef0f4] px-4 py-3">
            <p className="m-0 text-sm font-medium text-[#293242]">{displayName}</p>
            <p className="m-0 mt-0.5 text-xs text-[#768091]">{roleLabel}</p>
          </div>
          {role === "admin" ? (
            <>
              <AccountLink href="/workspace/settings/members" label="成员与权限" onClick={() => setOpen(false)} />
              <button
                className="flex w-full px-4 py-2.5 text-left text-sm text-[#455163] transition hover:bg-[#f6f8fc] hover:text-[#3f60e8]"
                onClick={() => {
                  setOpen(false);
                  setModelSettingsOpen(true);
                }}
                type="button"
              >
                模型设置
              </button>
            </>
          ) : null}
          {role === "expert" ? (
            <button
              className="flex w-full px-4 py-2.5 text-left text-sm text-[#455163] transition hover:bg-[#f6f8fc] hover:text-[#3f60e8]"
              onClick={() => {
                setOpen(false);
                setPasswordOpen(true);
              }}
              type="button"
            >
              修改密码
            </button>
          ) : (
            <AccountLink href="/workspace/settings/password" label="修改密码" onClick={() => setOpen(false)} />
          )}
          <div className="my-2 border-t border-[#eef0f4]" />
          <button
            className="flex w-full items-center px-4 py-2.5 text-left text-sm text-[#c6474e] transition hover:bg-[#fff4f4]"
            onClick={() => signOut({ callbackUrl: "/" })}
            type="button"
          >
            退出登录
          </button>
        </div>
      ) : null}
      {passwordOpen ? <ChangePasswordModal onClose={() => setPasswordOpen(false)} /> : null}
      {modelSettingsOpen ? <ModelConnectionModal onClose={() => setModelSettingsOpen(false)} /> : null}
    </div>
  );
}

function ModelConnectionModal({ onClose }: Readonly<{ onClose: () => void }>) {
  const [provider, setProvider] = useState("DeepSeek");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState("");
  const [testing, setTesting] = useState(false);
  const [hasSavedApiKey, setHasSavedApiKey] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      try {
        const response = await fetch("/api/v1/model-connection");
        const body = await response.json() as { data?: { provider: string; baseUrl: string; model: string; hasApiKey: boolean } | null };
        if (!response.ok || !body.data) return;
        setProvider(body.data.provider);
        setBaseUrl(body.data.baseUrl);
        setModel(body.data.model);
        setHasSavedApiKey(body.data.hasApiKey);
        setMessage("已加载数据库中的模型连接设置。");
      } catch {
        setMessage("模型连接设置读取失败。");
      }
    }
    void loadSettings();
  }, []);

  async function applySettings() {
    if (!provider.trim() || !baseUrl.trim()) {
      setMessage("请填写服务商和 API 基础地址。");
      return;
    }
    try {
      const response = await fetch("/api/v1/model-connection", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.trim(), baseUrl: baseUrl.trim(), model: model.trim(), apiKey })
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "模型连接设置保存失败。");
      setApiKey("");
      setHasSavedApiKey(true);
      setMessage("模型连接设置已保存。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "模型连接设置保存失败。");
    }
  }

  async function testConnection() {
    if (!baseUrl.trim() || (!apiKey.trim() && !hasSavedApiKey)) {
      setMessage("请先填写 API 基础地址和 API Key，或先应用已保存的设置。");
      return;
    }
    setTesting(true);
    setMessage("");
    try {
      const response = await fetch("/api/v1/model-connection/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: provider.trim(), baseUrl: baseUrl.trim(), model: model.trim(), apiKey })
      });
      const body = await response.json() as { data?: { reply?: string }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? `测试连接失败（HTTP ${response.status}）。`);
      setMessage(`连接成功：模型已回应“${body.data?.reply ?? "你好"}”`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "测试连接失败，请检查配置。");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div aria-labelledby="model-connection-title" aria-modal="true" className="fixed inset-0 z-[220] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]" role="dialog">
      <div className="w-full max-w-[405px] overflow-hidden rounded-xl bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]">
        <div className="flex items-center justify-between border-b border-[#e7ebf2] px-5 py-4">
          <h2 className="m-0 text-sm font-semibold text-[#293242]" id="model-connection-title">模型连接设置</h2>
          <button aria-label="关闭" className="border-0 bg-transparent text-lg font-light text-[#5f6e85]" onClick={onClose} type="button">×</button>
        </div>
        <div className="space-y-3 px-5 py-4">
          <p className="m-0 rounded-md border border-[#f0d9aa] bg-[#fffaf0] px-3 py-2 text-[11px] leading-5 text-[#9b7340]">ⓘ 配置保存在数据库中，API Key 不会在页面回显。测试连接会向当前 API 发送“你好”。</p>
          <ModalField label="服务商" onChange={setProvider} value={provider} />
          <ModalField label="API基础地址" onChange={setBaseUrl} value={baseUrl} />
          <ModalField label="模型名称（识别码则留空为准）" onChange={setModel} value={model} />
          <ModalField label={hasSavedApiKey ? "API Key（已保存，留空则保持不变）" : "API Key"} onChange={setApiKey} type="password" value={apiKey} />
          <p className="m-0 text-[11px] leading-4 text-[#7c899d]">配置为管理员全局设置，不写入项目业务数据。修改 Key 后点击“应用设置”才会更新已保存的 Key。</p>
          <p className="m-0 text-[11px] text-[#7c899d]">DeepSeek 未填写模型名称时将默认使用 `deepseek-chat`；其他服务商请填写实际模型识别码。</p>
          {message ? <p className={message.includes("已保存") || message.includes("已加载") || message.includes("连接成功") ? "m-0 text-xs text-[#25886a]" : "m-0 text-xs text-[#c6474e]"}>{message}</p> : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-[#e7ebf2] bg-[#fafbfe] px-5 py-3">
          <button className="rounded-md border border-[#dce3ee] bg-white px-3 py-2 text-xs text-[#536178]" onClick={() => { setApiKey(""); setMessage("已清空当前输入，数据库中的已保存 Key 未修改。"); }} type="button">清空输入密钥</button>
          <button className="rounded-md border border-[#dce3ee] bg-white px-3 py-2 text-xs text-[#536178] disabled:cursor-not-allowed disabled:opacity-60" disabled={testing} onClick={() => void testConnection()} type="button">{testing ? "测试中..." : "测试连接"}</button>
          <button className="rounded-md bg-[#3f60e8] px-3 py-2 text-xs font-medium text-white" onClick={() => void applySettings()} type="button">应用设置</button>
        </div>
      </div>
    </div>
  );
}

function ModalField({ label, onChange, type = "text", value }: Readonly<{ label: string; onChange: (value: string) => void; type?: string; value: string }>) {
  return <label className="block text-[11px] text-[#71809a]">{label}<input className="mt-1.5 h-8 w-full rounded border border-[#d6e0ef] px-2 text-xs text-[#385578] outline-none focus:border-[#7598ef]" onChange={(event) => onChange(event.target.value)} type={type} value={value} /></label>;
}

function ChangePasswordModal({ onClose }: Readonly<{ onClose: () => void }>) {
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");

    if (newPassword !== confirmPassword) {
      setMessage("两次输入的新密码不一致。");
      return;
    }
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/v1/auth/password", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ currentPassword, newPassword })
    });
    const payload = await response.json();
    setSaving(false);
    if (!response.ok) {
      setMessage(payload.error?.message ?? "密码修改失败。");
      return;
    }
    setMessage("密码已修改，正在退出登录，请使用新密码重新登录。");
    window.setTimeout(() => void signOut({ callbackUrl: "/" }), 900);
  }

  return (
    <div aria-modal="true" className="fixed inset-0 z-[220] grid place-items-center bg-[#263548]/55 p-4 backdrop-blur-[2px]" role="dialog">
      <form className="w-full max-w-[810px] overflow-hidden rounded-[22px] bg-white shadow-[0_22px_55px_rgba(29,42,59,0.24)]" onSubmit={submit}>
        <div className="flex items-center justify-between border-b border-[#e5e9f0] px-9 py-6">
          <h2 className="m-0 text-[26px] font-semibold text-[#293242]">修改本人密码</h2>
          <button aria-label="关闭" className="border-0 bg-transparent text-3xl text-[#6f8099]" onClick={onClose} type="button">×</button>
        </div>
        <div className="space-y-6 px-9 py-12">
          <PasswordField label="当前密码" name="currentPassword" />
          <PasswordField label="新密码" name="newPassword" />
          <PasswordField label="确认初始密码" name="confirmPassword" />
          {message ? <p className={message.includes("已修改") ? "text-[#25886a]" : "text-[#c6474e]"}>{message}</p> : null}
        </div>
        <div className="flex justify-end gap-3 border-t border-[#e5e9f0] bg-[#fafbfe] px-9 py-5">
          <button className="rounded-xl border border-[#d5e0ef] bg-white px-5 py-3 text-base text-[#4e6484]" onClick={onClose} type="button">取消</button>
          <button className="rounded-xl bg-[#405fe7] px-5 py-3 text-base font-medium text-white disabled:bg-[#aab7e8]" disabled={saving} type="submit">{saving ? "正在修改…" : "修改密码"}</button>
        </div>
      </form>
    </div>
  );
}

function PasswordField({ label, name }: Readonly<{ label: string; name: string }>) {
  return (
    <label className="block text-[#6680a5]">
      {label}
      <input
        autoComplete={name === "currentPassword" ? "current-password" : "new-password"}
        className="mt-3 h-15 w-full rounded-xl border border-[#d7e1ef] px-4 text-[#30415e] outline-none focus:border-[#7598ef]"
        minLength={8}
        name={name}
        required
        type="password"
      />
    </label>
  );
}

function AccountLink({
  href,
  label,
  onClick
}: Readonly<{
  href: string;
  label: string;
  onClick: () => void;
}>) {
  return (
    <Link
      className="flex px-4 py-2.5 text-sm text-[#455163] no-underline transition hover:bg-[#f6f8fc] hover:text-[#3f60e8]"
      href={href}
      onClick={onClick}
    >
      {label}
    </Link>
  );
}
