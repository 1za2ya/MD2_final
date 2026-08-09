"""Maze Trace XR の客観的な行動ログを集計・可視化する。"""

from pathlib import Path
import argparse
import pandas as pd
import matplotlib.pyplot as plt


def load_data(export_dir: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    sessions = pd.read_csv(export_dir / "sessions.csv")
    movement = pd.read_csv(export_dir / "movement_logs.csv")
    coins = pd.read_csv(export_dir / "coin_logs.csv")

    # 文字列のままでは並び替えや計算が誤るため、分析に使う列だけ明示的に数値へ変換する。
    numeric_session_columns = [
        "clear_time", "total_distance", "average_speed", "maximum_speed",
        "stop_time", "revisit_count", "dead_end_count", "trial_number", "is_cleared"
    ]
    for column in numeric_session_columns:
        sessions[column] = pd.to_numeric(sessions[column], errors="coerce")
    for column in ["elapsed_time", "pos_x", "pos_y", "rotation_y", "speed", "nearest_opponent_distance", "current_rank"]:
        movement[column] = pd.to_numeric(movement[column], errors="coerce")
    for column in ["coin_x", "coin_y", "coin_z", "collected_order", "elapsed_time", "collected_coins", "remaining_coins"]:
        coins[column] = pd.to_numeric(coins[column], errors="coerce")

    # 再送で同じ時点のログが重複しても経路密度へ二重計上しないよう、観測キーで除外する。
    movement = movement.drop_duplicates(subset=["session_id", "elapsed_time"], keep="last")
    # 座標または経過時間が欠けた行は線の順序と距離を確定できないため、経路分析から除外する。
    movement = movement.dropna(subset=["session_id", "elapsed_time", "pos_x", "pos_y"])
    movement = movement.sort_values(["session_id", "elapsed_time"]).reset_index(drop=True)
    coins = coins.drop_duplicates(subset=["session_id", "coin_id"], keep="last")
    return sessions, movement, coins


def calculate_distances(sessions: pd.DataFrame, movement: pd.DataFrame) -> pd.DataFrame:
    ordered = movement.sort_values(["session_id", "elapsed_time"]).copy()
    ordered["diff_x"] = ordered.groupby("session_id")["pos_x"].diff()
    ordered["diff_y"] = ordered.groupby("session_id")["pos_y"].diff()
    # 0.1秒ごとのX-Y座標差を合計し、最終時間だけでは分からない経路効率を算出する。
    ordered["segment_distance"] = (ordered["diff_x"].pow(2) + ordered["diff_y"].pow(2)).pow(.5)
    totals = ordered.groupby("session_id", as_index=False)["segment_distance"].sum().rename(
        columns={"segment_distance": "logged_total_distance"}
    )
    result = sessions.merge(totals, on="session_id", how="left")
    result["reported_total_distance"] = result["total_distance"]
    # 第18項では0.1秒ログ間の距離を正式値とするため、クライアント集計値ではなく座標から再計算する。
    result["total_distance"] = result["logged_total_distance"].fillna(0)
    return result


def save_summary(sessions: pd.DataFrame, output_dir: Path) -> pd.DataFrame:
    cleared = sessions[sessions["is_cleared"] == 1].copy()
    if cleared.empty:
        raise ValueError("クリア済みセッションがないため、クリア時間の分析を実行できません。")

    # 極端な記録の影響を受けにくい中央値を境界にし、探索効率の違いを比較する。
    median_time = cleared["clear_time"].median()
    cleared["speed_group"] = cleared["clear_time"].le(median_time).map({True: "fast", False: "slow"})
    summary = cleared.groupby(["game_mode", "speed_group"], dropna=False).agg(
        sessions=("session_id", "count"),
        clear_time_mean=("clear_time", "mean"),
        distance_mean=("total_distance", "mean"),
        stop_time_mean=("stop_time", "mean"),
        revisit_mean=("revisit_count", "mean")
    ).reset_index()
    summary.to_csv(output_dir / "summary.csv", index=False)
    return cleared


def plot_session_metrics(cleared: pd.DataFrame, output_dir: Path) -> None:
    fig, axes = plt.subplots(1, 3, figsize=(15, 4.8))
    colors = cleared["game_mode"].map({"solo": "#3d8f82", "multiplayer": "#e0a92f"})
    axes[0].scatter(cleared["total_distance"], cleared["clear_time"], c=colors, alpha=.78)
    axes[0].set(xlabel="Total distance (m)", ylabel="Clear time (s)", title="Distance and clear time")
    axes[1].scatter(cleared["stop_time"], cleared["clear_time"], c=colors, alpha=.78)
    axes[1].set(xlabel="Stop time (s)", ylabel="Clear time (s)", title="Stops and clear time")
    axes[2].scatter(cleared["revisit_count"], cleared["clear_time"], c=colors, alpha=.78)
    axes[2].set(xlabel="Revisit count", ylabel="Clear time (s)", title="Revisits and clear time")
    fig.tight_layout()
    fig.savefig(output_dir / "session_metrics.png", dpi=180)
    plt.close(fig)


def route_comparison_targets(cleared: pd.DataFrame) -> list[tuple[str, pd.Series]]:
    if cleared.empty:
        return []
    targets = [
        ("Fastest player", cleared.loc[cleared["clear_time"].idxmin()]),
        ("Slowest player", cleared.loc[cleared["clear_time"].idxmax()])
    ]
    repeated = cleared.sort_values("trial_number").groupby("player_id").filter(lambda rows: len(rows) >= 2)
    if not repeated.empty:
        player_id = repeated.iloc[0]["player_id"]
        trials = repeated[repeated["player_id"] == player_id].head(2)
        targets.extend((f"Same player / trial {int(row['trial_number'])}", row) for _, row in trials.iterrows())
    for mode, label in [("solo", "Solo route"), ("multiplayer", "Multiplayer route")]:
        candidates = cleared[cleared["game_mode"] == mode]
        if not candidates.empty:
            targets.append((label, candidates.loc[candidates["clear_time"].idxmin()]))
    return targets


def plot_routes(cleared: pd.DataFrame, movement: pd.DataFrame, coins: pd.DataFrame, output_dir: Path) -> None:
    targets = route_comparison_targets(cleared)
    if not targets:
        return
    columns = 2
    rows = (len(targets) + columns - 1) // columns
    fig, axes = plt.subplots(rows, columns, figsize=(11, 5 * rows), squeeze=False)
    for axis, (label, session) in zip(axes.flat, targets):
        route = movement[movement["session_id"] == session["session_id"]].sort_values("elapsed_time")
        axis.plot(route["pos_x"], route["pos_y"], linewidth=1.5, color="#1d766b", label="Route")
        if not route.empty:
            axis.scatter(route.iloc[0]["pos_x"], route.iloc[0]["pos_y"], s=55, color="#2a9d5b", marker="o", label="Start")
            axis.scatter(route.iloc[-1]["pos_x"], route.iloc[-1]["pos_y"], s=55, color="#d95151", marker="X", label="End")
        # 低速地点は心理状態と断定せず、座標変化が小さい客観的な停止候補として重ねる。
        stops = route[route["speed"] < .08]
        axis.scatter(stops["pos_x"], stops["pos_y"], s=12, alpha=.35, color="#3977d4", label="Low-speed sample")
        coin_points = coins[coins["session_id"] == session["session_id"]].sort_values("collected_order")
        axis.scatter(coin_points["coin_x"], coin_points["coin_z"], s=45, color="#e0a92f", marker="D", label="Coin")
        for _, coin in coin_points.iterrows():
            axis.annotate(str(int(coin["collected_order"])), (coin["coin_x"], coin["coin_z"]), xytext=(4, 4), textcoords="offset points")
        axis.set_aspect("equal")
        axis.set_title(f"{label}: {session['player_id']} / {session['clear_time']:.1f}s")
        axis.set(xlabel="X position", ylabel="Y position")
        axis.invert_yaxis()
        axis.legend(fontsize=7, loc="best")
    for axis in list(axes.flat)[len(targets):]:
        axis.set_visible(False)
    fig.tight_layout()
    fig.savefig(output_dir / "route_comparisons.png", dpi=180)
    plt.close(fig)


def plot_multiplayer_routes(sessions: pd.DataFrame, movement: pd.DataFrame, output_dir: Path) -> None:
    multiplayer = sessions[sessions["game_mode"] == "multiplayer"]
    room_counts = multiplayer.groupby("room_id")["player_id"].nunique()
    eligible_rooms = room_counts[room_counts >= 2]
    if eligible_rooms.empty:
        return
    room_id = eligible_rooms.index[0]
    room_sessions = multiplayer[multiplayer["room_id"] == room_id]
    fig, axis = plt.subplots(figsize=(7, 6))
    # 同一ルームの足取りを同じ座標系へ重ね、接近箇所や経路選択の類似を比較可能にする。
    for _, session in room_sessions.iterrows():
        route = movement[movement["session_id"] == session["session_id"]].sort_values("elapsed_time")
        axis.plot(route["pos_x"], route["pos_y"], linewidth=1.4, label=session["player_id"])
    axis.set(xlabel="X position", ylabel="Y position", title=f"Multiplayer routes / room {room_id}")
    axis.set_aspect("equal")
    axis.invert_yaxis()
    axis.legend()
    fig.tight_layout()
    fig.savefig(output_dir / "multiplayer_routes.png", dpi=180)
    plt.close(fig)


def plot_heatmap(movement: pd.DataFrame, output_dir: Path) -> None:
    valid = movement.dropna(subset=["pos_x", "pos_y"])
    if valid.empty:
        return
    fig, axis = plt.subplots(figsize=(7, 6))
    # 0.5m幅へ区切ることで、小さな揺れより通路単位の滞在傾向を読みやすくする。
    histogram = axis.hist2d(valid["pos_x"], valid["pos_y"], bins=36, cmap="YlOrBr")
    fig.colorbar(histogram[3], ax=axis, label="Recorded samples")
    axis.set(xlabel="X", ylabel="Z", title="Movement heatmap")
    axis.set_aspect("equal")
    axis.invert_yaxis()
    fig.tight_layout()
    fig.savefig(output_dir / "heatmap.png", dpi=180)
    plt.close(fig)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, default=Path("data/exports"))
    parser.add_argument("--output", type=Path, default=Path("analysis_output"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    sessions, movement, coins = load_data(args.input)
    sessions = calculate_distances(sessions, movement)
    cleared = save_summary(sessions, args.output)
    plot_session_metrics(cleared, args.output)
    plot_routes(cleared, movement, coins, args.output)
    plot_multiplayer_routes(sessions, movement, args.output)
    plot_heatmap(movement, args.output)
    correlations = cleared[["clear_time", "total_distance", "stop_time", "revisit_count"]].corr()
    correlations.to_csv(args.output / "correlations.csv")
    print(f"分析結果を {args.output.resolve()} に保存しました。")


if __name__ == "__main__":
    main()
