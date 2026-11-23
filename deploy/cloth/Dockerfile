# 衣冠复原实验台：只用 Python 标准库，无第三方依赖
FROM python:3.12-slim
WORKDIR /app
COPY server.py ./
COPY site ./site
COPY seed ./seed
ENV CLOTH_DATA=/data/cloth CLOTH_BIND=0.0.0.0 CLOTH_PORT=8790
RUN mkdir -p /data/cloth && chown 1000:1000 /data/cloth
VOLUME ["/data/cloth"]
EXPOSE 8790
USER 1000:1000
CMD ["python", "server.py"]
