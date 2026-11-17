"""Create the reviewable Word PRD from its version-controlled Markdown source."""
from pathlib import Path
import re
from docx import Document
from docx.shared import Mm,Pt,RGBColor
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT,WD_CELL_VERTICAL_ALIGNMENT

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'docs/AIGC沉浸式空间内容生产管线平台_PRD_v1.1.docx'
doc=Document();sec=doc.sections[0]
sec.page_width=Mm(210);sec.page_height=Mm(297)
sec.top_margin=Mm(18);sec.bottom_margin=Mm(18);sec.left_margin=Mm(20);sec.right_margin=Mm(20)
for name in ['Normal','Title','Subtitle','Heading 1','Heading 2']:
    style=doc.styles[name];style.font.name='Microsoft YaHei';style.font.color.rgb=RGBColor(0,0,0)
    style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'Microsoft YaHei')
doc.styles['Normal'].font.size=Pt(10)
doc.styles['Normal'].paragraph_format.line_spacing=1.22
doc.styles['Normal'].paragraph_format.space_after=Pt(6)
doc.styles['Title'].font.size=Pt(22);doc.styles['Title'].paragraph_format.space_after=Pt(12)
doc.styles['Heading 1'].font.size=Pt(16);doc.styles['Heading 1'].paragraph_format.space_after=Pt(9)
doc.styles['Heading 1'].paragraph_format.keep_with_next=True
header=sec.header.paragraphs[0];header.text='空间内容工场    产品需求文档 v1.1';header.style='Caption'
header.runs[0].font.color.rgb=RGBColor(0,0,0)
footer=sec.footer.paragraphs[0];footer.alignment=WD_ALIGN_PARAGRAPH.RIGHT
footer.add_run('2026 年 11 月 17 日    第 ')
fld=OxmlElement('w:fldSimple');fld.set(qn('w:instr'),'PAGE');footer._p.append(fld);footer.add_run(' 页')

lines=(ROOT/'docs/PRD-v1.1.md').read_text('utf-8').splitlines();i=0
while i<len(lines):
    line=lines[i].strip()
    if not line:i+=1;continue
    if line.startswith('|'):
        rows=[]
        while i<len(lines) and lines[i].strip().startswith('|'):
            row=[c.strip() for c in lines[i].strip().strip('|').split('|')]
            if not all(re.fullmatch(r'[-: ]+',c) for c in row):rows.append(row)
            i+=1
        n=len(rows[0]);table=doc.add_table(rows=0, cols=n);table.alignment=WD_TABLE_ALIGNMENT.CENTER;table.autofit=False
        weights={3:[.24,.37,.39],4:[.20,.27,.25,.28],5:[.26,.18,.18,.16,.22]}.get(n,[1/n]*n)
        for col,w in zip(table.columns,weights):col.width=Mm(170*w)
        for ri,row in enumerate(rows):
            cells=table.add_row().cells
            if ri==0:
                repeat=OxmlElement('w:tblHeader');table.rows[-1]._tr.get_or_add_trPr().append(repeat)
            trPr=table.rows[-1]._tr.get_or_add_trPr();trPr.append(OxmlElement('w:cantSplit'))
            for j,(cell,text) in enumerate(zip(cells,row)):
                cell.width=Mm(170*weights[j]);cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
                cell.text=text.replace('/','/\u200b') if text.startswith(('GET ','POST ')) else text;props=cell._tc.get_or_add_tcPr()
                shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'E4EAF0' if ri==0 else ('F7F9FA' if ri%2==0 else 'FFFFFF'));props.append(shade)
                borders=OxmlElement('w:tcBorders')
                for side in ['top','left','bottom','right']:
                    b=OxmlElement('w:'+side);b.set(qn('w:val'),'single');b.set(qn('w:sz'),'4');b.set(qn('w:color'),'D9D9D9');borders.append(b)
                props.append(borders);m=OxmlElement('w:tcMar')
                for side in ['top','left','bottom','right']:
                    e=OxmlElement('w:'+side);e.set(qn('w:w'),'75');e.set(qn('w:type'),'dxa');m.append(e)
                props.append(m)
                for p in cell.paragraphs:
                    p.paragraph_format.space_after=Pt(2);p.paragraph_format.space_before=Pt(2);p.paragraph_format.line_spacing=1.12
                    for r in p.runs:r.font.size=Pt(9);r.bold=ri==0
        doc.add_paragraph().paragraph_format.space_after=Pt(1)
        continue
    if line.startswith('# '):doc.add_paragraph('AIGC沉浸式空间内容生产管线平台\n产品需求文档',style='Title')
    elif line.startswith('## '):
        title=line[3:]
        if title.split(' ')[0] in ['2','3','4','5','6','7','8','9']:doc.add_page_break()
        doc.add_heading(title,level=1)
    else:doc.add_paragraph(line)
    i+=1
doc.core_properties.title='AIGC沉浸式空间内容生产管线平台产品需求文档'
doc.core_properties.subject='PRD v1.1 真实道具闭环 精细展示母版 终端交付与对外演示'
doc.core_properties.author='咪咕数智文旅中心'
for root in [doc.styles.element,doc.element]:
    for border in list(root.iter(qn('w:pBdr'))):border.getparent().remove(border)
doc.save(OUT)
print(OUT)
