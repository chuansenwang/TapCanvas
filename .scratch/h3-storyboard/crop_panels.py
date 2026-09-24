"""把 12 格分镜表切成单格画面，用于本地 H3 逐镜生成。

输入：C:/Users/ASDWERT/Downloads/Qwen_image_2.1_00017.png（1664x1248，4 列 x 3 行）
输出：
  panels/p01.png ... p12.png   仅渲染画面，避开「P0x」编号、颜色图例与底部中文说明
  layout/p01.png   ... p12.png 含编号、图例与说明的完整格子，仅供人工查阅
  contact_render.png           带渲染切框的对照图

第 1 格（P01）在图例右侧、左下角色轨迹箭头右上方仍有一块干净画面，
因此单独给出一个窄的渲染视口；其余格使用整格画面区。
"""

from pathlib import Path

from PIL import Image, ImageDraw

SOURCE = Path(r"C:\Users\ASDWERT\Downloads\Qwen_image_2.1_00017.png")
ROOT = Path(__file__).resolve().parent
PANEL_DIR = ROOT / "panels"
LAYOUT_DIR = ROOT / "layout"

# 列边界来自对白色分隔带的实测结果（1664 宽 4 等分）
COL_BOUNDS = [2, 448, 840, 1236, 1662]

# 每行画面区的上下边界：下边界取「画面 + 镜头标题」之前，排除底部中文说明文字
ROW_ART_BOUNDS = [(6, 296), (428, 702), (840, 1098)]

# P01 的左上角是编号与颜色图例，左下角是角色轨迹箭头，两者都会污染首帧。
# 该格换成一块覆盖主体构图、不含任何标注的右半区视口（绝对像素坐标）。
OVERRIDE_BOXES: dict[int, tuple[int, int, int, int]] = {
    1: (250, 100, 442, 300),
}


def main() -> None:
    PANEL_DIR.mkdir(parents=True, exist_ok=True)
    LAYOUT_DIR.mkdir(parents=True, exist_ok=True)
    sheet = Image.open(SOURCE).convert("RGB")
    draw = ImageDraw.Draw(sheet)

    index = 1
    for row, (art_top, art_bottom) in enumerate(ROW_ART_BOUNDS):
        for col in range(4):
            left = COL_BOUNDS[col] + 6
            right = COL_BOUNDS[col + 1] - 6
            layout_box = (left, art_top, right, art_bottom)
            sheet.crop(layout_box).save(LAYOUT_DIR / f"p{index:02d}.png")

            if index in OVERRIDE_BOXES:
                box = OVERRIDE_BOXES[index]
            else:
                box = (left, art_top, right, art_bottom)
            panel = sheet.crop(box)
            target = PANEL_DIR / f"p{index:02d}.png"
            panel.save(target)
            draw.rectangle(box, outline=(255, 0, 0), width=2)
            print(f"p{index:02d} row={row} col={col} box={box} size={panel.size}")
            index += 1

    sheet.save(ROOT / "contact_render.png")
    print(f"contact sheet -> {ROOT / 'contact_render.png'}")


if __name__ == "__main__":
    main()
