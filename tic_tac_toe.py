import tkinter as tk

def create_gui():
    root = tk.Tk()
    root.title("Tic Tac Toe")
    root.configure(bg="#2b2b2b")
    
    game_frame = tk.Frame(root, bg="#2b2b2b")
    game_frame.pack(padx=20, pady=20)
    
    buttons = []
    current_player = "X"
    game_over = False
    
    def check_winner():
        patterns = [
            (0, 1, 2), (3, 4, 5), (6, 7, 8),
            (0, 3, 6), (1, 4, 7), (2, 5, 8),
            (0, 4, 8), (2, 4, 6)
        ]
        for a, b, c in patterns:
            if buttons[a]["text"] == buttons[b]["text"] == buttons[c]["text"] != "":
                return buttons[a]["text"]
        if all(btn["text"] != "" for btn in buttons):
            return "Draw"
        return None
    
    def on_click(index):
        nonlocal current_player, game_over
        
        if buttons[index]["text"] != "" or game_over:
            return
        
        buttons[index]["text"] = current_player
        buttons[index]["fg"] = "#ff6b6b" if current_player == "X" else "#4ecdc4"
        
        winner = check_winner()
        if winner:
            game_over = True
            status.config(text=f"Player {winner} wins!", fg="#f7dc6f")
        elif winner == "Draw":
            game_over = True
            status.config(text="It's a Draw!", fg="#f7dc6f")
        else:
            current_player = "O" if current_player == "X" else "X"
            status.config(text=f"Player {current_player}'s turn", fg="#ffffff")
    
    def reset():
        nonlocal current_player, game_over
        current_player = "X"
        game_over = False
        status.config(text="Player X's turn", fg="#ffffff")
        for btn in buttons:
            btn.config(text="", fg="#ffffff")
    
    for i in range(9):
        btn = tk.Button(
            game_frame,
            text="",
            font=("Arial", 40, "bold"),
            width=3,
            height=1,
            bg="#3b3b3b",
            fg="#ffffff",
            activebackground="#4b4b4b",
            activeforeground="#ffffff",
            relief="flat",
            command=lambda i=i: on_click(i)
        )
        btn.grid(row=i//3, column=i%3, padx=5, pady=5)
        buttons.append(btn)
    
    status = tk.Label(
        root,
        text="Player X's turn",
        font=("Arial", 16),
        bg="#2b2b2b",
        fg="#ffffff"
    )
    status.pack(pady=(0, 10))
    
    reset_btn = tk.Button(
        root,
        text="Reset",
        font=("Arial", 14),
        bg="#4b4b4b",
        fg="#ffffff",
        activebackground="#5b5b5b",
        activeforeground="#ffffff",
        relief="flat",
        padx=20,
        command=reset
    )
    reset_btn.pack(pady=(10, 0))
    
    root.mainloop()

if __name__ == "__main__":
    create_gui()
