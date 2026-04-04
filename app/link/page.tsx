export default function LinkPage() {
    return (
        <div className="flex h-screen items-center justify-center">
            <form className="flex flex-col gap-3">
                <h1>Link Telegram Group</h1>

                <input
                    name="code"
                    placeholder="Enter group code"
                    className="border p-2"
                />

                <button className="bg-black text-white p-2">
                    Link group
                </button>
            </form>
        </div>
    )
}