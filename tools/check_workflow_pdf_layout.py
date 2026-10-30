"""Independent development QA: verify manifests and render every golden PDF with Poppler."""
import argparse,hashlib,json,shutil,subprocess
from pathlib import Path
import fitz
from PIL import Image,ImageDraw,ImageFont

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--matrix',action='append',required=True)
    parser.add_argument('--output',default='tmp/pdfs/workflow-phase-b-golden')
    args=parser.parse_args()
    output=Path(args.output).resolve();output.mkdir(parents=True,exist_ok=True)
    poppler=shutil.which('pdftoppm')
    if not poppler:raise RuntimeError('Poppler is required for independent golden review')
    all_pages=[];records=[];seen=set()
    for matrix in args.matrix:
        data=json.loads(Path(matrix).read_text(encoding='utf-8'))
        for case in data['results']:
            folder=Path(case['path'])
            if folder in seen:continue
            seen.add(folder)
            manifest=json.loads((folder/'manifest.json').read_text(encoding='utf-8'))
            assert manifest['exportStatus']=='verified' and manifest['synthetic']
            assert sum(f['role']=='teacher' for f in manifest['outputs'])==1
            for file in manifest['outputs']:
                path=folder/file['relativePath'];raw=path.read_bytes()
                assert hashlib.sha256(raw).hexdigest()==file['sha256']
                index=len(records);target=output/f'pdf-{index:03d}';target.mkdir(exist_ok=True)
                with fitz.open(path) as pdf:
                    assert len(pdf)==file['pages']
                    for page in pdf:
                        assert abs(page.rect.width-595.276)<1 and abs(page.rect.height-841.89)<1
                        text=page.get_text()
                        assert '不可分发' in text and '\ufffd' not in text
                        for x0,y0,x1,y1,*_ in page.get_text('words'):
                            assert x0>=0 and y0>=0 and x1<=page.rect.width+1 and y1<=page.rect.height+1
                    font_ids={font[0] for i in range(len(pdf)) for font in pdf.get_page_fonts(i,full=True)}
                    for font_id in font_ids:
                        assert font_id>0 and pdf.extract_font(font_id)[3],(path,font_id)
                subprocess.run([poppler,'-r','144','-png',str(path),str(target/'page')],check=True,capture_output=True)
                images=sorted(target.glob('page-*.png'))
                assert len(images)==file['pages']
                for page,image in enumerate(images,1):all_pages.append((image,f'{case["mode"]}/{case["layout"]} {file["relativePath"]} p{page}'))
                records.append({'file':str(path),'pages':len(images),'renderDirectory':str(target)})
    font_path=Path('C:/Windows/Fonts/arial.ttf')
    font=ImageFont.truetype(str(font_path),13) if font_path.exists() else ImageFont.load_default()
    sheets=[]
    for start in range(0,len(all_pages),9):
        sheet=Image.new('RGB',(1080,1620),'#dddddd');draw=ImageDraw.Draw(sheet)
        for i,(file,label) in enumerate(all_pages[start:start+9]):
            image=Image.open(file).convert('RGB');image.thumbnail((348,500))
            x=(i%3)*360+6;y=(i//3)*540+28
            sheet.paste(image,(x,y));draw.text((x,y-20),label[:48],font=font,fill='black')
        path=output/f'contact-{len(sheets)+1:02d}.jpg';sheet.save(path,quality=94);sheets.append(str(path))
    summary={'files':len(records),'pages':len(all_pages),'records':records,'contactSheets':sheets,'visualReviewRequired':True}
    (output/'independent-qa.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'files':len(records),'pages':len(all_pages),'contactSheets':sheets}))

if __name__=='__main__':main()
