"""предразметка датасета в формате COCO 1.0"""

from ultralytics import YOLO
from pathlib import Path
from PIL import Image
import json
import shutil

if __name__ == "__main__":

    model = YOLO("models/yolo/bubbles_detect_v1.pt")
    src = Path(r"D:\My_Code\_Datasets\manga\unmarked")


    images = sorted(
        p for p in src.iterdir()
        if p.suffix.lower() in {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
    )
    print(f"изображений: {len(images)}")

    out = Path("training/predannotation_coco")
    img_dir = out / "images"
    ann_dir = out / "annotations"
    img_dir.mkdir(parents=True, exist_ok=True)
    ann_dir.mkdir(parents=True, exist_ok=True)

    coco = {
        "licenses": [{"id": 0, "name": "", "url": ""}],
        "info": {"description": "manga bubble predannotation v1"},
        "categories": [{"id": 1, "name": "location-of-bubbles", "supercategory": ""}],
        "images": [],
        "annotations": [],
    }

    results = model.predict(
        source=[str(p) for p in images],
        conf=0.25,
        iou=0.5,
        imgsz=1024,
        stream=True,
        verbose=False,
    )

    ann_id = 1
    total_boxes = 0
    for img_id, (img_path, r) in enumerate(zip(images, results), start=1):
        shutil.copy2(img_path, img_dir / img_path.name)
        W, H = Image.open(img_path).size

        coco["images"].append(
            {
                "id": img_id,
                "file_name": img_path.name,
                "width": W,
                "height": H,
                "license": 0,
                "flickr_url": "",
                "coco_url": "",
                "date_captured": 0,
            }
        )

        if r.boxes is not None and len(r.boxes) > 0:
            # normalized cx,cy,w,h → absolute x,y,w,h (top-left origin)
            for cx, cy, w, h in r.boxes.xywhn.tolist():
                bw, bh = w * W, h * H
                x, y = cx * W - bw / 2, cy * H - bh / 2
                coco["annotations"].append(
                    {
                        "id": ann_id,
                        "image_id": img_id,
                        "category_id": 1,
                        "bbox": [round(x, 2), round(y, 2), round(bw, 2), round(bh, 2)],
                        "area": round(bw * bh, 2),
                        "iscrowd": 0,
                        "segmentation": [],
                    }
                )
                ann_id += 1
                total_boxes += 1

    (ann_dir / "instances_default.json").write_text(json.dumps(coco), encoding="utf-8")

    print(
        f"изображений: {len(images)}, bbox'ов: {total_boxes}, "
        f"в среднем {total_boxes / len(images):.1f} на страницу"
    )