from ultralytics import YOLO
from pathlib import Path

if __name__ == "__main__":

    # model = YOLO("yolov8s.pt")
    model = YOLO(r"models/yolo/bubbles_detect_v1.pt")

    model.train(
        data=str(Path(r"D:\My_Code\_Datasets\manga\merged_ds\dataset.yaml").resolve()),
        epochs=100,
        imgsz=1024,
        batch=4,
        workers=2,
        project=str(Path(__file__).resolve().parent / "runs"),
        name="bubbles",
        patience=30,
        fliplr=0.5,
        flipud=0.0,
    )