import { PageHeader } from "@/components/settings/member-management";

export function ModelSettings({ projectCount }: Readonly<{ projectCount: number }>) {
  return (
    <section>
      <PageHeader
        description="模型连接按项目隔离保存；API Key 仅在服务端加密存储，页面不会回显历史明文。"
        title="模型设置"
      />
      {projectCount === 0 ? (
        <div className="settings-card grid min-h-56 place-items-center px-8 text-center">
          <div>
            <p className="m-0 text-base font-medium text-[#293242]">请先创建项目</p>
            <p className="m-0 mt-2 max-w-lg text-sm text-[#768091]">
              模型配置需要绑定具体项目，确保模型调用、资料依据和成本记录均可追溯。项目创建后可在这里填写 AI 中转站地址、模型映射和运行参数。
            </p>
          </div>
        </div>
      ) : (
        <div className="settings-card max-w-[800px] p-6">
          <div className="settings-form-grid">
            <SettingsField label="配置名称" placeholder="例如：默认生产配置" />
            <SettingsField label="中转站 Base URL" placeholder="https://api.example.com/v1" />
            <SettingsField label="默认模型" placeholder="请输入实际可用模型名" />
            <SettingsField label="API Key" placeholder="填写新 Key 时才会更新" type="password" />
            <SettingsField label="命题模型" placeholder="用于计划与试题生成" />
            <SettingsField label="复核模型" placeholder="用于质量复核" />
            <SettingsField label="超时（秒）" placeholder="60" type="number" />
            <SettingsField label="重试次数" placeholder="2" type="number" />
          </div>
          <p className="mb-0 mt-5 text-xs text-[#768091]">模型保存、连接测试与调用记录会在项目创建模块实现后启用。</p>
        </div>
      )}
    </section>
  );
}

function SettingsField({
  label,
  placeholder,
  type = "text"
}: Readonly<{
  label: string;
  placeholder: string;
  type?: string;
}>) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input placeholder={placeholder} readOnly type={type} />
    </label>
  );
}
