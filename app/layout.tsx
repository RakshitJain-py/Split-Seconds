export const metadata = {
    title: "SplitSeconds",
    description: "AI expense splitting"
}

export default function RootLayout({
    children,
}: {
    children: React.ReactNode
}) {
    return (
        <html lang="en">
            <body>
                {children}
            </body>
        </html>
    )
}