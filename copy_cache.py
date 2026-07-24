import shutil
import os

source_dir = r"C:\Users\ashwi\.gemini\antigravity\scratch\oracle-fdi-portal\cache"
target_dir = r"C:\Users\ashwi\.gemini\antigravity\scratch\fdi-lineage-explorer\cache"

os.makedirs(target_dir, exist_ok=True)

if os.path.exists(source_dir):
    for filename in os.listdir(source_dir):
        if filename.endswith(".xlsx"):
            src_path = os.path.join(source_dir, filename)
            tgt_path = os.path.join(target_dir, filename)
            shutil.copy2(src_path, tgt_path)
            print(f"Copied {filename} to cache")
else:
    print("Source cache directory not found")

# Also copy already downloaded key list
key_list_source = r"C:\Users\ashwi\.gemini\antigravity\scratch\oracle-fdi-portal\ERP_Data_Augmentation_Entity_Key_List.xlsx"
key_list_target = r"C:\Users\ashwi\.gemini\antigravity\scratch\fdi-lineage-explorer\cache\aug_ERP.xlsx"
if os.path.exists(key_list_source):
    shutil.copy2(key_list_source, key_list_target)
    print("Copied ERP_Data_Augmentation_Entity_Key_List.xlsx to cache/aug_ERP.xlsx")
