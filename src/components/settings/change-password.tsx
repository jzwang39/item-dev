"use client";

import { FormEvent, useState } from "react";
import { signOut } from "next-auth/react";

export function ChangePassword() {
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
    setMessage("密码已修改。为确保账户安全，请重新登录。");
    window.setTimeout(() => void signOut({ callbackUrl: "/" }), 1200);
  }

  return (
    <section>
      <div className="mb-6">
        <p className="m-0 text-sm text-[#768091]">账户设置</p>
        <h1 className="mb-1 mt-1 text-[23px] font-semibold text-[#293242]">修改密码</h1>
        <p className="m-0 text-xs text-[#768091]">修改成功后会撤销所有已登录会话，并要求重新登录。</p>
      </div>
      <form className="settings-card max-w-[580px] p-6" onSubmit={submit}>
        <div className="space-y-5">
          <PasswordField label="当前密码" name="currentPassword" />
          <PasswordField label="新密码" name="newPassword" />
          <PasswordField label="确认新密码" name="confirmPassword" />
        </div>
        {message ? <p className="settings-message mt-5">{message}</p> : null}
        <div className="mt-6 flex justify-end">
          <button className="settings-primary-button" disabled={saving} type="submit">
            {saving ? "正在修改…" : "修改密码"}
          </button>
        </div>
      </form>
    </section>
  );
}

function PasswordField({ label, name }: Readonly<{ label: string; name: string }>) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input autoComplete={name === "currentPassword" ? "current-password" : "new-password"} minLength={8} name={name} required type="password" />
    </label>
  );
}
