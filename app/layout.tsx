import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI 作业批改助手",
  description: "面向教师的 AI 作业批改工作台",
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
