import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "技能人才评价国家题库智能命题平台",
  description: "智能命题、专家审定与题库组卷平台"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
