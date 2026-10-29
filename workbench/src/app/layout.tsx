import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { Nav } from "@/components/nav"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import "./globals.css"

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] })
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] })

export const metadata: Metadata = {
  title: "AE 技术支持工作台",
  description: "聊天记录一键整理成技术支持记录，按客户回看全过程，沉淀需求线索。",
}

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-muted/40">
        <TooltipProvider>
          <div className="flex min-h-screen flex-col md:flex-row">
            <Nav />
            <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
              <div className="mx-auto max-w-6xl">{children}</div>
            </main>
          </div>
        </TooltipProvider>
        <Toaster richColors position="top-center" />
      </body>
    </html>
  )
}
