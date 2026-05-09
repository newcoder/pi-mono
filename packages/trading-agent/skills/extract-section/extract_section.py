"""
PDF Section Extractor — 从长文档中智能提取指定章节

用法:
    python extract_section.py <pdf_path> <section_keyword> [output_dir]

示例:
    python extract_section.py report.pdf "五年财务概要" ./output

依赖:
    pip install pymupdf
"""

import fitz
import sys
import os
import json


def find_in_toc(doc, keyword):
    """在 PDF 目录中搜索关键词，返回 (level, title, page) 列表"""
    toc = doc.get_toc()
    results = []
    for level, title, page in toc:
        if keyword.lower() in title.lower():
            results.append((level, title, page))
    return results


def find_section_range(doc, keyword):
    """找到章节的起始页码和结束页码（由下一同级或上级章节决定）"""
    toc = doc.get_toc()
    target = None
    target_idx = -1

    for i, (level, title, page) in enumerate(toc):
        if keyword.lower() in title.lower():
            target = (level, title, page)
            target_idx = i
            break

    if target is None:
        return None, None

    _, title, start_page = target

    # Find end page: next item at same or higher level
    end_page = len(doc)  # default to end of document
    for i in range(target_idx + 1, len(toc)):
        next_level, next_title, next_page = toc[i]
        if next_level <= target[0]:
            end_page = next_page
            break

    return start_page, end_page


def render_pages(doc, start_page, end_page, output_dir, dpi=200):
    """渲染指定页码范围到 PNG"""
    os.makedirs(output_dir, exist_ok=True)
    pages = []

    for p in range(start_page - 1, end_page - 1):  # 0-indexed
        page = doc[p]
        pix = page.get_pixmap(dpi=dpi)
        filename = f"page_{p+1}.png"
        filepath = os.path.join(output_dir, filename)
        pix.save(filepath)
        pages.append({"page": p + 1, "file": filepath, "size": f"{pix.width}x{pix.height}"})
        print(f"  Rendered page {p+1} → {filepath}")

    return pages


def main():
    if len(sys.argv) < 3:
        print("用法: python extract_section.py <pdf_path> <section_keyword> [output_dir]")
        print("示例: python extract_section.py report.pdf \"五年财务概要\" ./output")
        sys.exit(1)

    pdf_path = sys.argv[1]
    keyword = sys.argv[2]
    output_dir = sys.argv[3] if len(sys.argv) > 3 else "./extracted_section"

    print(f"📄 打开文档: {pdf_path}")
    doc = fitz.open(pdf_path)
    print(f"   总页数: {len(doc)}")

    # First try TOC
    print(f"\n🔍 搜索章节: \"{keyword}\"")
    results = find_in_toc(doc, keyword)

    if results:
        print(f"   在目录中找到 {len(results)} 处匹配:")
        for level, title, page in results:
            indent = "  " * level
            print(f"   {indent}L{level} | p{page} | {title}")
        start_p, end_p = find_section_range(doc, keyword)
    else:
        print("   ❌ 目录中未找到匹配")
        print("   💡 提示: 尝试不同的关键词，或先查看目录结构")
        doc.close()
        sys.exit(1)

    if start_p:
        print(f"\n📑 章节范围: 第 {start_p} 页 ~ 第 {end_p - 1} 页")
        print(f"\n🖼️  渲染页面 ({len(range(start_p - 1, end_p - 1))} 页)...")
        pages = render_pages(doc, start_p, end_p, output_dir)

        # Save metadata
        meta = {
            "pdf": pdf_path,
            "keyword": keyword,
            "section_title": results[0][1] if results else keyword,
            "start_page": start_p,
            "end_page": end_p,
            "pages_rendered": len(pages),
            "output_dir": output_dir,
            "pages": pages,
        }
        meta_path = os.path.join(output_dir, "metadata.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        print(f"\n✅ 完成！共渲染 {len(pages)} 页")
        print(f"   输出目录: {output_dir}")
        print(f"   下一步: 对每个 PNG 调用 pp-ocrv5 的 ocr 工具提取文字")
        print(f"   元数据: {meta_path}")
    else:
        print("❌ 未找到章节位置")

    doc.close()


if __name__ == "__main__":
    main()
