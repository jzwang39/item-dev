"use client";

import { FormEvent, useEffect, useState } from "react";

type Account = {
  id: string;
  username: string;
  display_name: string;
  role: "admin" | "expert";
  phone: string | null;
  email: string | null;
  status: "active" | "disabled";
  created_at: string;
};

const emptyForm = { username: "", displayName: "", password: "", phone: "", email: "" };
const emptyEditForm = { displayName: "", phone: "", email: "" };

export function MemberManagement() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState(emptyEditForm);
  const [showCreate, setShowCreate] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [updatingAccountId, setUpdatingAccountId] = useState<string | null>(null);

  async function loadAccounts() {
    setLoading(true);
    const response = await fetch("/api/v1/accounts", { cache: "no-store" });
    const payload = await response.json();
    setLoading(false);
    if (!response.ok) {
      setMessage(payload.error?.message ?? "成员数据加载失败。");
      return;
    }
    setAccounts(payload.data);
  }

  useEffect(() => {
    void loadAccounts();
  }, []);

  async function createExpert(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const response = await fetch("/api/v1/accounts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });
    const payload = await response.json();
    if (!response.ok) {
      setMessage(payload.error?.message ?? "创建专家账号失败。");
      return;
    }
    setForm(emptyForm);
    setShowCreate(false);
    setMessage("专家账号已创建，首次登录时需修改密码。");
    await loadAccounts();
  }

  async function removeAccount(account: Account) {
    if (!window.confirm(`确定软删除“${account.display_name}”吗？此操作会立即撤销其会话。`)) {
      return;
    }

    const response = await fetch(`/api/v1/accounts/${account.id}`, { method: "DELETE" });
    if (response.status === 204) {
      setMessage("账号已软删除。");
      await loadAccounts();
      return;
    }
    const payload = await response.json();
    setMessage(payload.error?.message ?? "删除账号失败。");
  }

  function openEdit(account: Account) {
    setEditForm({
      displayName: account.display_name,
      phone: account.phone ?? "",
      email: account.email ?? ""
    });
    setEditingAccount(account);
  }

  async function updateAccount(
    account: Account,
    input: { displayName: string; phone: string; email: string; status: Account["status"] },
    successMessage: string
  ) {
    setMessage("");
    setUpdatingAccountId(account.id);
    const response = await fetch(`/api/v1/accounts/${account.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    const payload = await response.json();
    setUpdatingAccountId(null);
    if (!response.ok) {
      setMessage(payload.error?.message ?? "成员信息更新失败。");
      return false;
    }
    setMessage(successMessage);
    await loadAccounts();
    return true;
  }

  async function saveAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingAccount) return;

    const updated = await updateAccount(
      editingAccount,
      { ...editForm, status: editingAccount.status },
      "成员信息已更新。"
    );
    if (updated) {
      setEditingAccount(null);
      setEditForm(emptyEditForm);
    }
  }

  async function toggleAccountStatus(account: Account) {
    const nextStatus = account.status === "active" ? "disabled" : "active";
    const action = nextStatus === "disabled" ? "停用" : "启用";
    if (nextStatus === "disabled" && !window.confirm(`确定停用“${account.display_name}”吗？该成员的全部会话将立即失效。`)) {
      return;
    }

    await updateAccount(
      account,
      {
        displayName: account.display_name,
        phone: account.phone ?? "",
        email: account.email ?? "",
        status: nextStatus
      },
      `成员已${action}。`
    );
  }

  return (
    <section>
      <PageHeader
        action={
          <button className="settings-primary-button" onClick={() => setShowCreate(true)} type="button">
            新建专家账号
          </button>
        }
        description="维护成员基本信息、账号状态与联系方式；停用成员会立即撤销其会话。"
        title="成员与权限"
      />
      {message ? <p className="settings-message">{message}</p> : null}
      <div className="settings-card overflow-x-auto">
        <table className="min-w-[760px] w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-[#e7eaf0] bg-[#fafbfe] text-[11px] text-[#78879a]">
              <th className="px-4 py-3 font-medium">姓名</th>
              <th className="px-4 py-3 font-medium">登录账号</th>
              <th className="px-4 py-3 font-medium">角色</th>
              <th className="px-4 py-3 font-medium">联系方式</th>
              <th className="px-4 py-3 font-medium">账号状态</th>
              <th className="px-4 py-3 text-right font-medium">操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-[#768091]" colSpan={6}>
                  正在加载成员…
                </td>
              </tr>
            ) : null}
            {!loading && accounts.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-[#768091]" colSpan={6}>
                  暂无成员账号。
                </td>
              </tr>
            ) : null}
            {accounts.map((account) => (
              <tr className="border-b border-[#eef0f4] text-[12px] text-[#455163]" key={account.id}>
                <td className="px-4 py-3">
                  <strong className="font-medium text-[#293242]">{account.display_name}</strong>
                </td>
                <td className="px-4 py-3 font-mono">{account.username}</td>
                <td className="px-4 py-3">
                  <span className={`settings-tag ${account.role === "admin" ? "settings-tag-admin" : ""}`}>
                    {account.role === "admin" ? "管理员" : "专家"}
                  </span>
                </td>
                <td className="px-4 py-3">{account.phone || account.email || "未填写"}</td>
                <td className="px-4 py-3">
                  <span className={`settings-tag ${account.status === "active" ? "settings-tag-active" : ""}`}>
                    {account.status === "active" ? "启用" : "停用"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    <button className="text-[#405fe7] hover:underline" onClick={() => openEdit(account)} type="button">
                      编辑
                    </button>
                    {account.role === "expert" ? (
                      <>
                        <button
                          className={account.status === "active" ? "text-[#c68a2e] hover:underline" : "text-[#25855a] hover:underline"}
                          disabled={updatingAccountId === account.id}
                          onClick={() => void toggleAccountStatus(account)}
                          type="button"
                        >
                          {updatingAccountId === account.id ? "处理中…" : account.status === "active" ? "停用" : "启用"}
                        </button>
                        <button className="text-[#c6474e] hover:underline" onClick={() => void removeAccount(account)} type="button">
                          删除
                        </button>
                      </>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showCreate ? (
        <div className="settings-modal" onMouseDown={(event) => event.target === event.currentTarget && setShowCreate(false)} role="dialog">
          <form className="settings-dialog" onSubmit={createExpert}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="m-0 text-xs text-[#3f60e8]">成员与权限</p>
                <h2 className="mb-0 mt-1 text-lg">新建专家账号</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setShowCreate(false)} type="button">
                ×
              </button>
            </div>
            <div className="settings-form-grid mt-6">
              <Field label="专家姓名" value={form.displayName} onChange={(value) => setForm({ ...form, displayName: value })} />
              <Field label="登录账号" value={form.username} onChange={(value) => setForm({ ...form, username: value })} />
              <Field label="初始密码" type="password" value={form.password} onChange={(value) => setForm({ ...form, password: value })} />
              <Field label="联系电话（选填）" value={form.phone} onChange={(value) => setForm({ ...form, phone: value })} />
              <Field label="邮箱（选填）" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
            </div>
            <p className="mb-0 mt-4 text-xs text-[#768091]">专家默认仅具备审定权限，项目级模块权限将在项目成员分配时设置。</p>
            <div className="mt-6 flex justify-end gap-3">
              <button className="settings-secondary-button" onClick={() => setShowCreate(false)} type="button">取消</button>
              <button className="settings-primary-button" type="submit">创建账号</button>
            </div>
          </form>
        </div>
      ) : null}

      {editingAccount ? (
        <div className="settings-modal" onMouseDown={(event) => event.target === event.currentTarget && setEditingAccount(null)} role="dialog">
          <form className="settings-dialog" onSubmit={saveAccount}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="m-0 text-xs text-[#3f60e8]">成员与权限</p>
                <h2 className="mb-0 mt-1 text-lg">编辑成员信息</h2>
              </div>
              <button className="settings-icon-button" onClick={() => setEditingAccount(null)} type="button">
                ×
              </button>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-4 rounded-lg bg-[#f7f9fc] px-4 py-3 text-xs text-[#5c6b80]">
              <span>登录账号：{editingAccount.username}</span>
              <span>角色：{editingAccount.role === "admin" ? "管理员" : "专家"}</span>
            </div>
            <div className="settings-form-grid mt-6">
              <Field label="成员姓名" value={editForm.displayName} onChange={(value) => setEditForm({ ...editForm, displayName: value })} />
              <Field label="联系电话（选填）" value={editForm.phone} onChange={(value) => setEditForm({ ...editForm, phone: value })} />
              <Field label="邮箱（选填）" value={editForm.email} onChange={(value) => setEditForm({ ...editForm, email: value })} />
            </div>
            <div className="mt-6 flex justify-end gap-3">
              <button className="settings-secondary-button" onClick={() => setEditingAccount(null)} type="button">取消</button>
              <button className="settings-primary-button" disabled={updatingAccountId === editingAccount.id} type="submit">
                {updatingAccountId === editingAccount.id ? "保存中…" : "保存修改"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text"
}: Readonly<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}>) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input minLength={type === "password" ? 8 : undefined} onChange={(event) => onChange(event.target.value)} required={label !== "联系电话（选填）" && label !== "邮箱（选填）"} type={type} value={value} />
    </label>
  );
}

export function PageHeader({
  title,
  description,
  action
}: Readonly<{
  title: string;
  description: string;
  action?: React.ReactNode;
}>) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <p className="m-0 text-sm text-[#768091]">系统设置</p>
        <h1 className="mb-1 mt-1 text-[23px] font-semibold text-[#293242]">{title}</h1>
        <p className="m-0 text-xs text-[#768091]">{description}</p>
      </div>
      {action}
    </div>
  );
}
