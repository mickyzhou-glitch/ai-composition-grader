import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "朱批 · AI作文批改助手",
  description: "面向教师的本地 AI 作文批改与复核工作台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
