import urllib.request
import zipfile
import xml.etree.ElementTree as ET
import os
import re
import sqlite3

# Sources definition
DOWNLOADS = {
    "lineage": {
        "ERP": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faiar/26R2_ERP_Semantic_Model_Lineage.xlsx",
        "HCM": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faihc/26R2_HCM_Semantic_Model_Lineage.xlsx",
        "SCM": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faisc/26R2_SCM_Semantic_Model_Lineage.xlsx",
        "CX": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faicx/26R2_CX_Semantic_Model_Lineage.xlsx"
    },
    "metrics": {
        "ERP": [
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faiar/26R2_ERP_Metric_Calculation_Logic.xlsx",
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faiar/26R2_ERP_SCM_PRC_Metric_Calculation_Logic.xlsx",
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faiar/26R2_ERP_PPM_Metric_Computation_Logic.xlsx"
        ],
        "HCM": [
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faihc/26R2_HCM_Metric_Calculation_Logic.xlsx"
        ],
        "SCM": [
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faisc/26R2_SCM_Metric_Calculation_Logic.xlsx",
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faisc/26R2_SCM_SCM_PRC_Metric_Calculation_Logic.xlsx"
        ],
        "CX": [
            "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faicx/26R2_CX_Metric_Calculation_Logic.xlsx"
        ]
    },
    "augmentation": {
        "ERP": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faiar/26R2_ERP_Data_Augmentation_Entity_Key_List.xlsx",
        "HCM": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faihc/26R2_HCM_Data_Augmentation_Entity_Key_List.xlsx",
        "SCM": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faisc/26R2_SCM_Data_Augmentation_Entity_Key_List.xlsx",
        "CX": "https://docs.oracle.com/en/cloud/saas/analytics/26r2/faicx/26R2_CX_Data_Augmentation_Entity_Key_List.xlsx"
    }
}

# Reusable robust XLSX parser
def read_xlsx(filepath):
    print(f"Parsing {filepath}...")
    if not os.path.exists(filepath):
        print(f"Error: file {filepath} not found!")
        return []
        
    with zipfile.ZipFile(filepath, 'r') as z:
        shared_strings = []
        if 'xl/sharedStrings.xml' in z.namelist():
            ss_content = z.read('xl/sharedStrings.xml')
            root = ET.fromstring(ss_content)
            ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            for si in root.findall('ns:si', ns):
                t_el = si.find('ns:t', ns)
                if t_el is not None:
                    shared_strings.append(t_el.text or "")
                else:
                    texts = [r.find('ns:t', ns).text for r in si.findall('ns:r', ns) if r.find('ns:t', ns) is not None]
                    shared_strings.append("".join(texts))
        
        wb_content = z.read('xl/workbook.xml')
        wb_root = ET.fromstring(wb_content)
        ns = {'ns': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
        
        sheet_path = 'xl/worksheets/sheet1.xml'
        if sheet_path not in z.namelist():
            sheet_paths = [name for name in z.namelist() if name.startswith('xl/worksheets/sheet')]
            if sheet_paths:
                sheet_path = sheet_paths[0]
                
        sheet_xml = z.read(sheet_path)
        sheet_root = ET.fromstring(sheet_xml)
        
        def col_to_idx(col_str):
            idx = 0
            for char in col_str:
                idx = idx * 26 + (ord(char.upper()) - 64)
            return idx - 1

        rows = []
        sheet_data = sheet_root.find('ns:sheetData', ns)
        if sheet_data is None:
            return []
            
        headers = []
        for r_idx, row_el in enumerate(sheet_data.findall('ns:row', ns)):
            row_dict = {}
            for cell in row_el.findall('ns:c', ns):
                ref = cell.attrib.get('r')
                col_letter = "".join([c for c in ref if c.isalpha()])
                col_idx = col_to_idx(col_letter)
                
                val_el = cell.find('ns:v', ns)
                val = val_el.text if val_el is not None else ""
                t = cell.attrib.get('t')
                if t == 's' and val:
                    idx = int(val)
                    val = shared_strings[idx] if idx < len(shared_strings) else val
                row_dict[col_idx] = val
                
            if r_idx == 0:
                max_col = max(row_dict.keys()) if row_dict else 0
                headers = [row_dict.get(i, "").strip() for i in range(max_col + 1)]
            else:
                max_col = len(headers) - 1
                row_data = {headers[i]: row_dict.get(i, "") for i in range(max_col + 1) if i < len(headers) and headers[i]}
                rows.append(row_data)
        
        print(f"Successfully loaded {len(rows)} rows.")
        return rows

def slugify(text):
    text = text.lower().strip()
    text = re.sub(r'[^a-z0-9\s-]', '', text)
    text = re.sub(r'[\s-]+', '_', text)
    return text

def download_file(url, local_name):
    cache_path = os.path.join("cache", local_name)
    os.makedirs("cache", exist_ok=True)

    # Check local Downloads folder first to allow offline manual updates
    downloads_dir = os.path.join("C:\\", "Users", "ashwi", "Downloads")
    name_map = {
        "lineage_ERP.xlsx": "26R2_ERP_Semantic_Model_Lineage.xlsx",
        "lineage_HCM.xlsx": "26R2_HCM_Semantic_Model_Lineage.xlsx",
        "lineage_SCM.xlsx": "26R2_SCM_Semantic_Model_Lineage.xlsx",
        "lineage_CX.xlsx": "26R2_CX_Semantic_Model_Lineage.xlsx",
        
        "aug_ERP.xlsx": "26R2_ERP_Data_Augmentation_Entity_Key_List.xlsx",
        "aug_HCM.xlsx": "26R2_HCM_Data_Augmentation_Entity_Key_List.xlsx",
        "aug_SCM.xlsx": "26R2_SCM_Data_Augmentation_Entity_Key_List.xlsx",
        "aug_CX.xlsx": "26R2_CX_Data_Augmentation_Entity_Key_List.xlsx",
        
        "metrics_ERP_0.xlsx": "26R2_ERP_Metric_Calculation_Logic.xlsx",
        "metrics_ERP_1.xlsx": "26R2_ERP_SCM_PRC_Metric_Calculation_Logic.xlsx",
        "metrics_ERP_2.xlsx": "26R2_ERP_PPM_Metric_Computation_Logic.xlsx",
        "metrics_HCM_0.xlsx": "26R2_HCM_Metric_Calculation_Logic.xlsx",
        "metrics_SCM_0.xlsx": "26R2_SCM_Metric_Calculation_Logic.xlsx",
        "metrics_SCM_1.xlsx": "26R2_SCM_SCM_PRC_Metric_Calculation_Logic.xlsx",
        "metrics_CX_0.xlsx": "26R2_CX_Metric_Calculation_Logic.xlsx"
    }

    mapped_name = name_map.get(local_name)
    if mapped_name:
        local_dl_path = os.path.join(downloads_dir, mapped_name)
        if os.path.exists(local_dl_path):
            print(f"Found manual download file: {local_dl_path}. Copying to cache...")
            import shutil
            shutil.copy(local_dl_path, cache_path)
            return cache_path

    if os.path.exists(cache_path):
        print(f"Using cached file {cache_path}")
        return cache_path

    print(f"Downloading {url} to {cache_path}...")
    headers = {'User-Agent': 'Mozilla/5.0'}
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req) as response:
        with open(cache_path, "wb") as f:
            f.write(response.read())
    return cache_path

def main():
    db_path = "fdi_lineage.db"
    print(f"Initializing SQLite database at {db_path}...")
    
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # 1. Setup Table Schema
    cursor.execute("DROP TABLE IF EXISTS lineage_mappings")
    cursor.execute("DROP TABLE IF EXISTS metrics")
    cursor.execute("DROP TABLE IF EXISTS subject_areas")
    cursor.execute("DROP TABLE IF EXISTS augmentations")
    
    cursor.execute("""
    CREATE TABLE subject_areas (
        slug TEXT PRIMARY KEY,
        name TEXT,
        pillars TEXT,
        metrics_count INTEGER DEFAULT 0,
        lineage_count INTEGER DEFAULT 0
    )
    """)
    
    cursor.execute("""
    CREATE TABLE lineage_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_area_slug TEXT,
        presentation_table TEXT,
        presentation_column TEXT,
        physical_table TEXT,
        physical_column TEXT,
        FOREIGN KEY(subject_area_slug) REFERENCES subject_areas(slug)
    )
    """)
    
    cursor.execute("""
    CREATE TABLE metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_area_slug TEXT,
        metric_name TEXT,
        logic TEXT,
        description TEXT,
        FOREIGN KEY(subject_area_slug) REFERENCES subject_areas(slug)
    )
    """)
    
    cursor.execute("""
    CREATE TABLE augmentations (
        table_name TEXT PRIMARY KEY,
        entity_name TEXT,
        domain_code TEXT,
        entity_keys TEXT,
        table_column TEXT
    )
    """)
    
    conn.commit()
    
    # In-memory dictionaries to accumulate counts and attributes
    subject_areas_map = {} # slug -> { "name": name, "pillars": set(), "metrics_count": 0, "lineage_count": 0 }
    metrics_batch = [] # tuples: (subject_area_slug, metric_name, logic, description)
    lineage_batch = [] # tuples: (subject_area_slug, presentation_table, presentation_column, physical_table, physical_column)
    augmentations_batch = [] # tuples: (table_name, entity_name, domain_code, entity_keys, table_column)
    
    # 2. Download & Parse Augmentations
    print("Processing Data Augmentations...")
    for pillar, url in DOWNLOADS["augmentation"].items():
        local_name = f"aug_{pillar}.xlsx"
        try:
            path = download_file(url, local_name)
            rows = read_xlsx(path)
            
            for r in rows:
                table_name = r.get("Table Name") or r.get("Entity Name") or ""
                entity_name = r.get("Augmentation Entity Name") or r.get("Description") or ""
                domain_code = r.get("Augmentation Entity Domain Code") or r.get("Domain Code") or ""
                entity_keys = r.get("Augmentation Entity Keys") or r.get("Primary Keys") or ""
                table_column = r.get("Extensible Table Column Name") or r.get("Column Name") or ""
                
                if not table_name:
                    continue
                    
                augmentations_batch.append((
                    table_name.strip(),
                    entity_name.strip(),
                    domain_code.strip(),
                    entity_keys.strip(),
                    table_column.strip()
                ))
        except Exception as e:
            print(f"Error processing augmentations for {pillar}: {e}")

    # Deduplicate augmentations (since primary key is table_name)
    deduped_augs = {}
    for aug in augmentations_batch:
        deduped_augs[aug[0]] = aug
        
    print(f"Inserting {len(deduped_augs)} data augmentations...")
    cursor.executemany("""
    INSERT OR REPLACE INTO augmentations (table_name, entity_name, domain_code, entity_keys, table_column)
    VALUES (?, ?, ?, ?, ?)
    """, list(deduped_augs.values()))
    conn.commit()

    # 3. Download & Parse Metrics
    print("Processing Calculated Metrics...")
    for pillar, urls in DOWNLOADS["metrics"].items():
        for i, url in enumerate(urls):
            local_name = f"metrics_{pillar}_{i}.xlsx"
            try:
                path = download_file(url, local_name)
                rows = read_xlsx(path)
                
                for r in rows:
                    subject_area = r.get("Subject Areas") or r.get("Subject Area") or ""
                    metric_name = r.get("Metric Name") or r.get("KPI Name") or ""
                    logic = r.get("Metric Computation Logic") or r.get("Metric Computation logic") or r.get("KPI Computation Logic") or ""
                    comments = r.get("Comments") or r.get("Description") or ""
                    
                    if not subject_area or not metric_name or subject_area.strip().lower().startswith("common"):
                        continue
                        
                    slug = slugify(subject_area)
                    if slug not in subject_areas_map:
                        subject_areas_map[slug] = {
                            "name": subject_area.strip(),
                            "pillars": set(),
                            "metrics_count": 0,
                            "lineage_count": 0
                        }
                    subject_areas_map[slug]["pillars"].add(pillar)
                    subject_areas_map[slug]["metrics_count"] += 1
                    
                    metrics_batch.append((
                        slug,
                        metric_name.strip(),
                        logic.strip(),
                        comments.strip()
                    ))
            except Exception as e:
                print(f"Error processing metrics from {url}: {e}")

    print(f"Inserting {len(metrics_batch)} calculated metrics...")
    cursor.executemany("""
    INSERT INTO metrics (subject_area_slug, metric_name, logic, description)
    VALUES (?, ?, ?, ?)
    """, metrics_batch)
    conn.commit()

    # 4. Download & Parse Lineage
    print("Processing Semantic Lineages...")
    for pillar, url in DOWNLOADS["lineage"].items():
        local_name = f"lineage_{pillar}.xlsx"
        try:
            path = download_file(url, local_name)
            rows = read_xlsx(path)
            
            for r in rows:
                subject_area = r.get("Subject Area") or ""
                pres_table = r.get("Presentation Table") or ""
                pres_col = r.get("Presentation Column") or ""
                phys_table = r.get("Physical Table") or ""
                phys_col = r.get("Physical Column") or ""
                
                if not subject_area or not pres_table or not pres_col or not phys_table or not phys_col or subject_area.strip().lower().startswith("common"):
                    continue
                    
                slug = slugify(subject_area)
                if slug not in subject_areas_map:
                    subject_areas_map[slug] = {
                        "name": subject_area.strip(),
                        "pillars": set(),
                        "metrics_count": 0,
                        "lineage_count": 0
                    }
                subject_areas_map[slug]["pillars"].add(pillar)
                subject_areas_map[slug]["lineage_count"] += 1
                
                lineage_batch.append((
                    slug,
                    pres_table.strip(),
                    pres_col.strip(),
                    phys_table.strip(),
                    phys_col.strip()
                ))
        except Exception as e:
            print(f"Error processing lineage from {url}: {e}")

    print(f"Inserting {len(lineage_batch)} lineage mappings...")
    chunk_size = 50000
    for idx in range(0, len(lineage_batch), chunk_size):
        chunk = lineage_batch[idx : idx + chunk_size]
        cursor.executemany("""
        INSERT INTO lineage_mappings (subject_area_slug, presentation_table, presentation_column, physical_table, physical_column)
        VALUES (?, ?, ?, ?, ?)
        """, chunk)
        conn.commit()

    # 5. Insert Subject Areas Catalog
    print(f"Inserting {len(subject_areas_map)} Subject Areas catalog...")
    subject_areas_list = []
    for slug, sa in subject_areas_map.items():
        pillars_str = ",".join(sorted(list(sa["pillars"])))
        subject_areas_list.append((
            slug,
            sa["name"],
            pillars_str,
            sa["metrics_count"],
            sa["lineage_count"]
        ))
        
    cursor.executemany("""
    INSERT OR REPLACE INTO subject_areas (slug, name, pillars, metrics_count, lineage_count)
    VALUES (?, ?, ?, ?, ?)
    """, subject_areas_list)
    conn.commit()
    
    # 6. Verify Database counts
    print("\n--- DATABASE SUMMARY ---")
    cursor.execute("SELECT COUNT(*) FROM subject_areas")
    print(f"Subject Areas: {cursor.fetchone()[0]}")
    cursor.execute("SELECT COUNT(*) FROM lineage_mappings")
    print(f"Lineage Mappings: {cursor.fetchone()[0]}")
    cursor.execute("SELECT COUNT(*) FROM metrics")
    print(f"Calculated Metrics: {cursor.fetchone()[0]}")
    cursor.execute("SELECT COUNT(*) FROM augmentations")
    print(f"Data Augmentations: {cursor.fetchone()[0]}")
    print("------------------------\n")
    
    # Index for fast joins and fetches
    print("Building SQLite query indexes...")
    cursor.execute("CREATE INDEX idx_lineage_sa ON lineage_mappings(subject_area_slug)")
    cursor.execute("CREATE INDEX idx_metrics_sa ON metrics(subject_area_slug)")
    conn.commit()
    
    conn.close()
    print("Database build completed successfully!")

if __name__ == "__main__":
    main()
