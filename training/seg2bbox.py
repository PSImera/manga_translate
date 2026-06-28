'''Converts YOLO segmentation labels (polygons) to detection bbox format'''
from pathlib import Path

if __name__ == "__main__":
    root = Path(r"D:\My_Code\_Datasets\manga\merged_ds\labels")

    for path in root.rglob("*.txt"):
        lines = path.read_text(encoding="utf-8").splitlines()
        new_lines = []

        for line in lines:
            parts = line.strip().split()
            if not parts:
                continue
            elif len(parts) == 5:
                new_lines.append(line.strip())
                continue
            else:
                cls = parts[0]
                coords = list(map(float, parts[1:]))
                xs = coords[0::2]
                ys = coords[1::2]
                cx = (min(xs) + max(xs)) / 2
                cy = (min(ys) + max(ys)) / 2
                w  = max(xs) - min(xs)
                h  = max(ys) - min(ys)
                new_lines.append(f"{cls} {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}")
                changed = True

        path.write_text("\n".join(new_lines), encoding="utf-8")
