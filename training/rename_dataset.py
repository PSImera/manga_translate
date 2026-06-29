from pathlib import Path

base = Path(__file__).parent

for split in ["train", "val", "test"]:
    images = sorted((base / "images" / split).iterdir())
    for i, img in enumerate(images, 1):
        new_name = f"img_{i:06d}.jpg"
        img.rename(img.parent / new_name)
        label = base / "labels" / split / (img.stem + ".txt")
        if label.exists():
            label.rename(label.parent / f"img_{i:06d}.txt")
    print(f"{split}: {len(images)} files renamed")
